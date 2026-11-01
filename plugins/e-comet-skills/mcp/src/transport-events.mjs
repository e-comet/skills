// The last transport events this process saw that otherwise reach only stderr: a late answer after its request
// settled, a failed connect, a session end, a failed registration step and a broker failure record seen before a later
// start deletes it (spec §7.3). Closed kinds and short identifier codes only: never a request id, a path or a message.
import { BRIDGE_IDENTIFIER } from './bridge-codes.mjs';

export const TRANSPORT_EVENT_KINDS = Object.freeze(['late_answer', 'connect_failed', 'session_end', 'registration_step_failed', 'failure_record_seen']);

/** @param {{ capacity?: number, now?: () => number }} [options] */
export const createTransportEvents = ({ capacity = 32, now = Date.now } = {}) => {
    /** @type {Array<{ at: string, kind: string, code: string }>} */
    const events = [];
    return {
        capacity,
        /** @param {{ kind: string, code?: unknown }} event */
        add({ kind, code }) {
            if (!TRANSPORT_EVENT_KINDS.includes(kind) || typeof code !== 'string' || !BRIDGE_IDENTIFIER.test(code)) return;
            // A repeat of the newest event is the same condition persisting; it keeps its first time and takes no slot.
            const newest = events.at(-1);
            if (newest?.kind === kind && newest.code === code) return;
            events.push({ at: new Date(now()).toISOString(), kind, code });
            if (events.length > capacity) events.shift();
        },
        list: () => events.map((event) => ({ ...event })),
    };
};
