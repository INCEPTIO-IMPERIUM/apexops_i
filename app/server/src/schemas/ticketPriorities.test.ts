import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TICKET_PRIORITIES } from './ticket.schema';

// The server does not depend on @apexops/shared, and its tsconfig rootDir is
// src/, so the shared list is loaded at run time by path: this test is the only
// place the two lists meet.
const SHARED_PATH = pathToFileURL(path.resolve(__dirname, '../../../../packages/shared/src/types/tickets.ts')).href;

describe('ticket priorities', () => {
    it('are the same list, in the same order, as the clients use (@apexops/shared)', async () => {
        const shared = (await import(/* @vite-ignore */ SHARED_PATH)) as { TICKET_PRIORITIES: readonly string[] };
        expect([...TICKET_PRIORITIES]).toEqual([...shared.TICKET_PRIORITIES]);
    });
});
