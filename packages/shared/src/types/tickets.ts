/**
 * Ticket priorities as the API accepts them on the wire.
 *
 * The server keeps its own copy in `app/server/src/schemas/ticket.schema.ts`
 * because it does not depend on this package; `ticketPriorities.test.ts` there
 * fails the day the two differ.
 */
export const TICKET_PRIORITIES = ['low', 'medium', 'high', 'critical'] as const;

export type TicketPriority = (typeof TICKET_PRIORITIES)[number];
