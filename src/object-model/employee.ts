import type { SourceRef, RawRecord } from "./common.js";

/**
 * Employee — a person who can be assigned to tickets / appointments.
 *
 * Source-system mappings:
 *  - SAP C4C  → Employee
 *  - SAP ERP HR → PA0001 (org assignment) + PA0002 (personal data)
 *  - Active Directory (via Azure AD connector) → User
 */
export interface Employee extends SourceRef {
  /** Full display name. */
  name: string;
  firstName?: string;
  lastName?: string;
  /** Source-system "human" employee ID (e.g. C4C EmployeeID). */
  employeeId?: string;
  userId?: string;
  email?: string;
  phone?: string;
  region?: string;
  /** Owning organisational unit / team. */
  orgUnitId?: string;
  raw?: RawRecord;
}

/** A documented technical skill an employee holds. */
export interface Skill {
  name: string;
  /** Optional proficiency hint (source-dependent: 0-100 or a code). */
  level?: number | string;
  /** Free-text qualifier (e.g. "Mass Spec — TSQ family"). */
  qualifier?: string;
}

/** Membership in an organisational unit / service team. */
export interface TeamMembership extends SourceRef {
  employeeExternalId: string;
  orgUnitId: string;
  /** Role within the team (e.g. "lead", "senior", "apprentice"). */
  role?: string;
  /** Start of membership; an open-ended membership has no end. */
  validFrom?: string;
  validTo?: string;
}
