export const CONTRACTS_VERSION = "0.0.0";
export { ApiError, ErrorCode } from "./errors";
export { HealthResponse } from "./health";
export { routes } from "./routes";
export type { RouteContract } from "./routes";
export { Id, IsoDate, Version } from "./common";
export { AllocationCreate, AllocationLoad, AllocationPatch, AllocationPathParams, IfMatchHeader } from "./allocations";
export {
  ScheduleAccount, ScheduleAllocation, ScheduleDepartment, ScheduleHoliday, SchedulePage, SchedulePeopleType,
  SchedulePerson, ScheduleProject, ScheduleQuery, ScheduleResponse, ScheduleRole, ScheduleTimeoff, ScheduleTimeoffType,
} from "./schedule";
export {
  Change, ChangeEntity, REALTIME_PATH, REALTIME_PROTOCOL_VERSION, RealtimeChanges, RealtimeClientMessage, RealtimeError,
  RealtimeReady, RealtimeResync, RealtimeServerMessage, RealtimeSubscribe,
} from "./realtime";
export { TimeoffCreate, TimeoffPatch, TimeoffPathParams } from "./timeoffs";
