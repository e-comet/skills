// The kinds of transport event the bridge records and the status reports (spec §7.3): closed, so a status or a report
// never carries an event this process did not define.
export const TRANSPORT_EVENT_KINDS = [
    'late_answer',
    'connect_failed',
    'session_end',
    'registration_step_failed',
    'failure_record_seen',
];
