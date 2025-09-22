import type short from "short-uuid";
import type { z } from "zod";

import type { routingFormResponseInDbSchema } from "@calcom/app-store/routing-forms/zod";
import dayjs from "@calcom/dayjs";
import { HttpError } from "@calcom/lib/http-error";
import { isPrismaObjOrUndefined } from "@calcom/lib/isPrismaObj";
import { withReporting } from "@calcom/lib/sentryWrapper";
import prisma from "@calcom/prisma";
import { Prisma } from "@calcom/prisma/client";
import { BookingStatus, SchedulingType } from "@calcom/prisma/enums";
import type { CreationSource } from "@calcom/prisma/enums";
import type { CalendarEvent } from "@calcom/types/Calendar";

import type { TgetBookingDataSchema } from "../getBookingDataSchema";
import type { AwaitedBookingData, EventTypeId } from "./getBookingData";
import type { NewBookingEventType } from "./getEventTypesFromDB";
import type { LoadedUsers } from "./loadUsers";
import type { OriginalRescheduledBooking } from "./originalRescheduledBookingUtils";
import type { PaymentAppData, Tracking } from "./types";

type ReqBodyWithEnd = TgetBookingDataSchema & { end: string };

type CreateBookingParams = {
  uid: short.SUUID;
  routingFormResponseId: number | undefined;
  reroutingFormResponses: z.infer<typeof routingFormResponseInDbSchema> | null;
  rescheduledBy: string | undefined;
  reqBody: {
    user: ReqBodyWithEnd["user"];
    metadata: ReqBodyWithEnd["metadata"];
    recurringEventId: ReqBodyWithEnd["recurringEventId"];
  };
  eventType: {
    eventTypeData: NewBookingEventType;
    id: EventTypeId;
    slug: AwaitedBookingData["eventTypeSlug"];
    organizerUser: LoadedUsers[number] & {
      isFixed?: boolean;
      metadata?: Prisma.JsonValue;
    };
    isConfirmedByDefault: boolean;
    paymentAppData: PaymentAppData;
  };
  input: {
    bookerEmail: AwaitedBookingData["email"];
    rescheduleReason: AwaitedBookingData["rescheduleReason"];
    smsReminderNumber: AwaitedBookingData["smsReminderNumber"];
    responses: ReqBodyWithEnd["responses"] | null;
  };
  evt: CalendarEvent;
  originalRescheduledBooking: OriginalRescheduledBooking;
  creationSource?: CreationSource;
  tracking?: Tracking;
};

function updateEventDetails(
  evt: CalendarEvent,
  originalRescheduledBooking: OriginalRescheduledBooking | null
) {
  if (originalRescheduledBooking) {
    evt.description = originalRescheduledBooking?.description || evt.description;
    evt.location = evt.location || originalRescheduledBooking?.location;
  }
}

async function getAssociatedBookingForFormResponse(formResponseId: number) {
  const formResponse = await prisma.app_RoutingForms_FormResponse.findUnique({
    where: { id: formResponseId },
  });
  return formResponse?.routedToBookingUid ?? null;
}

// Define the function with underscore prefix
const _createBooking = async ({
  uid,
  reqBody,
  eventType,
  input,
  evt,
  originalRescheduledBooking,
  routingFormResponseId,
  reroutingFormResponses,
  rescheduledBy,
  creationSource,
  tracking,
}: CreateBookingParams & { rescheduledBy: string | undefined }) => {
  updateEventDetails(evt, originalRescheduledBooking);

  const associatedBookingForFormResponse = routingFormResponseId
    ? await getAssociatedBookingForFormResponse(routingFormResponseId)
    : null;

  const bookingAndAssociatedData = buildNewBookingData({
    uid,
    rescheduledBy,
    routingFormResponseId: shouldConnectBookingToFormResponse() ? routingFormResponseId : undefined,
    reroutingFormResponses,
    reqBody,
    eventType,
    input,
    evt,
    originalRescheduledBooking,
    creationSource,
    tracking,
  });

  return await saveBooking(
    bookingAndAssociatedData,
    originalRescheduledBooking,
    eventType.paymentAppData,
    eventType.organizerUser,
    eventType.eventTypeData?.schedulingType ?? null
  );

  function shouldConnectBookingToFormResponse() {
    const isRerouting = !!reroutingFormResponses;
    // Rerouting: luôn gắn vào form response gốc
    if (isRerouting) return true;
    // Nếu đã có booking gắn form response này, thôi không gắn nữa
    if (associatedBookingForFormResponse) return false;
    return true;
  }
};

export const createBooking = withReporting(_createBooking, "createBooking");

/**
 * NO-TRANSACTION VERSION
 * Thứ tự thao tác:
 *   (1) Hủy/cập nhật booking cũ (nếu là reschedule)
 *   (2) Kiểm tra conflict per-host (khi ROUND_ROBIN)
 *   (3) Tạo booking mới
 *   (4) Cập nhật form response (nếu có)
 *
 * RỦI RO: Không "atomic" như Serializable. Nên thêm UNIQUE/idempotency để bịt race hiếm gặp.
 */
async function saveBooking(
  bookingAndAssociatedData: ReturnType<typeof buildNewBookingData>,
  originalRescheduledBooking: OriginalRescheduledBooking,
  paymentAppData: PaymentAppData,
  organizerUser: CreateBookingParams["eventType"]["organizerUser"],
  eventSchedulingType?: SchedulingType | null
) {
  const { newBookingData, reroutingFormResponseUpdateData, originalBookingUpdateDataForCancellation } =
    bookingAndAssociatedData;

  const createBookingObj = {
    include: {
      user: { select: { email: true, name: true, timeZone: true, username: true } },
      attendees: true,
      payment: true,
      references: true,
    },
    data: newBookingData,
  };

  const enforcePerHostConflict = eventSchedulingType === SchedulingType.ROUND_ROBIN;

  // Giữ payment reference khi reschedule có thanh toán thành công
  if (originalRescheduledBooking?.paid && originalRescheduledBooking?.payment) {
    const bookingPayment = originalRescheduledBooking.payment.find((p) => p.success);
    if (bookingPayment) {
      (createBookingObj.data as Prisma.BookingCreateInput).payment = { connect: { id: bookingPayment.id } };
    }
  }

  // Nếu có giá > 0 thì đảm bảo credential tồn tại
  if (typeof paymentAppData.price === "number" && paymentAppData.price > 0) {
    await prisma.credential.findFirstOrThrow({
      where: {
        appId: paymentAppData.appId,
        ...(paymentAppData.credentialId ? { id: paymentAppData.credentialId } : { userId: organizerUser.id }),
      },
      select: { id: true },
    });
  }

  let didCancelOriginal = false;

  try {
    // (1) Hủy booking cũ nếu là reschedule (best-effort)
    if (originalBookingUpdateDataForCancellation) {
      await prisma.booking.update(originalBookingUpdateDataForCancellation);
      didCancelOriginal = true;
    }

    // (2) Kiểm tra conflict per-host khi ROUND_ROBIN
    if (enforcePerHostConflict) {
      const newBookingStart = (createBookingObj.data as Prisma.BookingCreateInput).startTime;
      const newBookingEnd = (createBookingObj.data as Prisma.BookingCreateInput).endTime;
      const conflictingBooking = await prisma.booking.findFirst({
        where: {
          userId: organizerUser.id,
          status: { in: [BookingStatus.ACCEPTED, BookingStatus.PENDING] },
          startTime: { lt: newBookingEnd },
          endTime: { gt: newBookingStart },
        },
        select: { id: true },
      });
      if (conflictingBooking) {
        throw new HttpError({ statusCode: 409, message: "Slot is no longer available" });
      }
    }

    // (3) Tạo booking mới
    const booking = await prisma.booking.create(createBookingObj as any);

    // (4) Cập nhật form response nếu có
    if (reroutingFormResponseUpdateData) {
      await prisma.app_RoutingForms_FormResponse.update(reroutingFormResponseUpdateData);
    }

    return booking;
  } catch (error: unknown) {
    // Map các lỗi về cùng semantics với bản dùng TX
    if (error instanceof HttpError) {
      await rollbackOriginalIfNeeded(didCancelOriginal, originalRescheduledBooking);
      throw error;
    }

    // UNIQUE conflict (khuyến nghị bạn thêm các index phù hợp)
    if (error?.code === "P2002") {
      await rollbackOriginalIfNeeded(didCancelOriginal, originalRescheduledBooking);
      throw new HttpError({ statusCode: 409, message: "Slot is no longer available" });
    }

    // P2034 (trước đây khi dùng TX Serializable) -> map về 409 cho UI
    if (error?.code === "P2034") {
      await rollbackOriginalIfNeeded(didCancelOriginal, originalRescheduledBooking);
      throw new HttpError({ statusCode: 409, message: "Slot is no longer available" });
    }

    // Lỗi khác: cố gắng khôi phục booking cũ nếu đã hủy
    await rollbackOriginalIfNeeded(didCancelOriginal, originalRescheduledBooking);
    throw error;
  }
}

async function rollbackOriginalIfNeeded(
  didCancelOriginal: boolean,
  originalRescheduledBooking: OriginalRescheduledBooking
) {
  if (!didCancelOriginal || !originalRescheduledBooking?.id) return;
  try {
    await prisma.booking.update({
      where: { id: originalRescheduledBooking.id },
      data: {
        rescheduled: false,
        status: originalRescheduledBooking.status ?? BookingStatus.ACCEPTED,
        rescheduledBy: null,
      },
    });
  } catch {
    // nuốt lỗi rollback best-effort
  }
}

function getEventTypeRel(eventTypeId: EventTypeId) {
  return eventTypeId ? { connect: { id: eventTypeId } } : {};
}

function getAttendeesData(evt: Pick<CalendarEvent, "attendees" | "team">) {
  const teamMembers = evt?.team?.members ?? [];
  return evt.attendees.concat(teamMembers).map((attendee) => ({
    name: attendee.name,
    email: attendee.email,
    timeZone: attendee.timeZone,
    locale: attendee.language.locale,
    phoneNumber: attendee.phoneNumber,
  }));
}

function buildNewBookingData(params: CreateBookingParams) {
  const {
    uid,
    evt,
    reqBody,
    eventType,
    input,
    originalRescheduledBooking,
    routingFormResponseId,
    reroutingFormResponses,
    rescheduledBy,
    creationSource,
    tracking,
  } = params;

  const attendeesData = getAttendeesData(evt);
  const eventTypeRel = getEventTypeRel(eventType.id);
  const reroutingFormResponseUpdateData = getReroutingFormResponseUpdateData({
    reroutingFormResponses,
    routingFormResponseId,
  });

  const newBookingData: Prisma.BookingCreateInput = {
    uid,
    userPrimaryEmail: evt.organizer.email,
    responses: input.responses === null || evt.seatsPerTimeSlot ? Prisma.JsonNull : input.responses,
    title: evt.title,
    startTime: dayjs.utc(evt.startTime).toDate(),
    endTime: dayjs.utc(evt.endTime).toDate(),
    description: evt.seatsPerTimeSlot ? null : evt.additionalNotes,
    customInputs: isPrismaObjOrUndefined(evt.customInputs),
    status: eventType.isConfirmedByDefault ? BookingStatus.ACCEPTED : BookingStatus.PENDING,
    oneTimePassword: evt.oneTimePassword,
    location: evt.location,
    eventType: eventTypeRel,
    smsReminderNumber: input.smsReminderNumber,
    metadata: reqBody.metadata,
    attendees: {
      createMany: { data: attendeesData },
    },
    dynamicEventSlugRef: !eventType.id ? eventType.slug : null,
    dynamicGroupSlugRef: !eventType.id ? (reqBody.user as string).toLowerCase() : null,
    iCalUID: evt.iCalUID ?? "",
    iCalSequence: originalRescheduledBooking ? evt.iCalSequence || 1 : 0,
    user: { connect: { id: eventType.organizerUser.id } },
    destinationCalendar:
      evt.destinationCalendar && evt.destinationCalendar.length > 0
        ? { connect: { id: evt.destinationCalendar[0].id } }
        : undefined,
    routedFromRoutingFormReponse: routingFormResponseId
      ? { connect: { id: routingFormResponseId } }
      : undefined,
    creationSource,
    tracking: tracking ? { create: tracking } : undefined,
  };

  if (reqBody.recurringEventId) {
    newBookingData.recurringEventId = reqBody.recurringEventId;
  }

  let originalBookingUpdateDataForCancellation: Prisma.BookingUpdateArgs | undefined = undefined;

  if (originalRescheduledBooking) {
    newBookingData.metadata = {
      ...(typeof originalRescheduledBooking.metadata === "object" && originalRescheduledBooking.metadata),
      ...reqBody.metadata,
    };
    newBookingData.paid = originalRescheduledBooking.paid;
    newBookingData.fromReschedule = originalRescheduledBooking.uid;
    if (originalRescheduledBooking.uid) {
      newBookingData.cancellationReason = input.rescheduleReason;
    }

    // Reschedule logic with seats: chỉ giữ attendee là booker
    if (
      newBookingData.attendees?.createMany?.data &&
      eventType?.eventTypeData?.seatsPerTimeSlot &&
      input.bookerEmail
    ) {
      newBookingData.attendees.createMany.data = attendeesData.filter(
        (attendee) => attendee.email === input.bookerEmail
      );
    }

    if (originalRescheduledBooking.recurringEventId) {
      newBookingData.recurringEventId = originalRescheduledBooking.recurringEventId;
    }

    if (!evt.seatsPerTimeSlot && originalRescheduledBooking?.uid) {
      originalBookingUpdateDataForCancellation = {
        where: { id: originalRescheduledBooking.id },
        data: {
          rescheduled: true,
          status: BookingStatus.CANCELLED,
          rescheduledBy: rescheduledBy,
        },
      };
    }
  }

  return {
    newBookingData,
    reroutingFormResponseUpdateData,
    originalBookingUpdateDataForCancellation,
  };

  function getReroutingFormResponseUpdateData({
    reroutingFormResponses,
    routingFormResponseId,
  }: {
    reroutingFormResponses: z.infer<typeof routingFormResponseInDbSchema> | null;
    routingFormResponseId: number | undefined | null;
  }) {
    if (!routingFormResponseId) return null;
    if (!reroutingFormResponses) return null;
    return {
      where: { id: routingFormResponseId },
      data: { response: reroutingFormResponses },
    };
  }
}

export type Booking = Awaited<ReturnType<typeof createBooking>>;
