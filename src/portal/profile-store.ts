// 013 profile store (SPEC.md §8.2 L2-8; specs/013 data-model.md "Profile store", research R9). The only place a
// person's name or email is kept: one small JSON file per user, owned by the portal. Nothing here is read by a
// payment decision, and none of it ever reaches L2 or the ledger (FR-046, NFR-004).
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { USER_ID_RE } from "../shared/user-id.js";

export const DISPLAY_NAME_MAX = 80;
export const EMAIL_MAX = 254;
export const POLICY_NAME_MAX = 60;
export const UNTITLED_POLICY = "Untitled policy";

export interface Profile {
  userId: string;
  displayName: string;
  contactEmail: string;
  /** Policy names, for their owner only. A removed policy keeps its name for the history. */
  policyNames: Record<string, string>;
  /** The card vault's customer reference. Never shown. */
  cardVaultCustomer?: string;
  updatedAt: string;
}

export interface ProfileIssue {
  field: string;
  code: string;
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** 1 to 80 characters after trimming, no control characters. Returns the trimmed value, or undefined. */
export function validDisplayName(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length >= 1 && t.length <= DISPLAY_NAME_MAX && !CONTROL_CHARS.test(t) ? t : undefined;
}

/** One `@`, a dot in the domain, at most 254 characters, no spaces. Not verified by mail. */
export function validEmail(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  if (t.length > EMAIL_MAX || /\s/.test(t) || CONTROL_CHARS.test(t)) return undefined;
  const parts = t.split("@");
  if (parts.length !== 2) return undefined;
  const [local, domain] = parts as [string, string];
  if (local.length === 0 || !/^[^.]+(\.[^.]+)+$/.test(domain)) return undefined;
  return t;
}

/** 1 to 60 characters after trimming, no control characters. */
export function validPolicyName(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length >= 1 && t.length <= POLICY_NAME_MAX && !CONTROL_CHARS.test(t) ? t : undefined;
}

export class ProfileStore {
  constructor(private readonly dir: string) {}

  /** The file of one user. The name is built only from a value that is a user identifier: anything else throws. */
  private pathFor(userId: string): string {
    if (!USER_ID_RE.test(userId)) throw new Error("profile store: not a user identifier");
    return join(this.dir, `${userId}.json`);
  }

  get(userId: string): Profile | undefined {
    const path = this.pathFor(userId);
    if (!existsSync(path)) return undefined;
    const raw = JSON.parse(readFileSync(path, "utf8")) as Profile;
    // A file is trusted only for its own user (FR-004).
    if (raw.userId !== userId) throw new Error("profile store: the file does not belong to this user");
    return { ...raw, policyNames: raw.policyNames ?? {} };
  }

  /** Writes through a temporary file and a rename, so a reader never sees half a profile. Mode 0600. */
  put(profile: Profile): Profile {
    const path = this.pathFor(profile.userId);
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(profile, null, 2) + "\n", { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
    return profile;
  }

  /** Reads, changes and writes one user's profile. Returns undefined when the user has none. */
  update(userId: string, change: (p: Profile) => Profile, nowMs: number = Date.now()): Profile | undefined {
    const current = this.get(userId);
    if (!current) return undefined;
    return this.put({ ...change(current), userId, updatedAt: new Date(nowMs).toISOString() });
  }
}
