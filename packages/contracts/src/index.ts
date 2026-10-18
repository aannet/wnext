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
