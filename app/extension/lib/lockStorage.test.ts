import { describe, expect, it, vi } from 'vitest';
import { lockStorage } from './lockStorage';

describe('lockStorage', () => {
    it('restricts every area to trusted contexts', () => {
        const local = { setAccessLevel: vi.fn(async () => undefined) };
        const session = { setAccessLevel: vi.fn(async () => undefined) };
        const report = vi.fn();
        lockStorage({ local, session }, report);
        expect(local.setAccessLevel).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' });
        expect(session.setAccessLevel).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' });
        expect(report).not.toHaveBeenCalled();
    });

    it('does not throw where the method is missing (it killed the worker), and still locks the other area', () => {
        const session = { setAccessLevel: vi.fn(async () => undefined) };
        const report = vi.fn();
        expect(() => lockStorage({ local: {}, session }, report)).not.toThrow();
        expect(session.setAccessLevel).toHaveBeenCalled();
        expect(report.mock.calls[0]![0]).toContain('storage.local');
    });

    it('reports a rejection or a synchronous throw instead of raising it', async () => {
        const report = vi.fn();
        const rejects = { setAccessLevel: async () => Promise.reject(new Error('no')) };
        const throws = {
            setAccessLevel: (): Promise<void> => {
                throw new Error('no');
            },
        };
        expect(() => lockStorage({ local: rejects, session: throws }, report)).not.toThrow();
        await new Promise((r) => setTimeout(r, 0));
        expect(report).toHaveBeenCalledTimes(2);
    });
});
