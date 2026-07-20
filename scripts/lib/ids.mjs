import { randomUUID } from "node:crypto";

export function makeId(prefix) {
  return `${prefix}_${randomUUID()}`;
}

export function nowIso(clock = Date) {
  return new clock().toISOString();
}
