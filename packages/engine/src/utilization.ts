// Miroir TS de utilization() : capacité nette (personnes actives) jointe à la charge planifiée.
// Sur-allocation rapportée, jamais bloquée (BR-01). Les états sous/OK/sur restent hors de la fonction (seuils par compte).
import { dailyCapacity, type CapacityInput } from "./capacity";
import { assertRange, windowDays } from "./dates";
import { plannedLoadByPerson, type AllocationInput } from "./load";

export interface UtilizationInput extends CapacityInput {
  allocations: readonly AllocationInput[];
}

export interface UtilizationRow {
  personId: string;
  day: string;
  capacityHours: number;
  plannedHours: number;
  tentativeHours: number;
  billableHours: number;
  /** max(planifié - capacité nette, 0) ; > 0 même à capacité 0 (BR-03, BR-38). */
  overtimeHours: number;
  /** planifié / capacité ; capacité 0 : Infinity si charge > 0 (sur-allocation maximale), 0 sinon (BR-38). Jamais null. */
  utilization: number;
  /** Vrai dès que planifié > capacité, y compris à capacité 0 : jamais masqué. */
  isOverbooked: boolean;
}

export function utilization(input: UtilizationInput): UtilizationRow[] {
  assertRange(input.from, input.to);
  const cal = windowDays(input.from, input.to);
  const load = plannedLoadByPerson(input, cal);
  const index = new Map(cal.iso.map((d, i) => [d, i]));
  return dailyCapacity(input).map((c) => {
    const l = load.get(c.personId)?.[index.get(c.day)!];
    const planned = l?.plannedHours ?? 0;
    return {
      personId: c.personId,
      day: c.day,
      capacityHours: c.capacityHours,
      plannedHours: planned,
      tentativeHours: l?.tentativeHours ?? 0,
      billableHours: l?.billableHours ?? 0,
      overtimeHours: Math.max(planned - c.capacityHours, 0),
      utilization: c.capacityHours === 0 ? (planned > 0 ? Infinity : 0) : planned / c.capacityHours,
      isOverbooked: planned > c.capacityHours,
    };
  });
}
