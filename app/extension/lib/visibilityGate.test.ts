import { afterEach, describe, expect, it, vi } from 'vitest';
import { createVisibilityGate, MIN_VISIBLE_MS } from './visibilityGate';

/** A fake IntersectionObserver v2: the test says when the browser reports visibility. */
function installV2() {
    const observers: { cb: IntersectionObserverCallback; observed: number }[] = [];
    class FakeIO {
        o: { cb: IntersectionObserverCallback; observed: number };
        constructor(cb: IntersectionObserverCallback) {
            this.o = { cb, observed: 0 };
            observers.push(this.o);
        }
        observe() {
            this.o.observed++;
        }
        disconnect() {}
    }
    // On the prototype, as in Chromium: that is what the support check looks at.
    class FakeEntry {}
    Object.defineProperty(FakeEntry.prototype, 'isVisible', { value: false });
    vi.stubGlobal('IntersectionObserver', FakeIO);
    vi.stubGlobal('IntersectionObserverEntry', FakeEntry);
    const report = (isVisible: boolean) => observers.forEach((o) => o.cb([{ isVisible } as unknown as IntersectionObserverEntry], {} as IntersectionObserver));
    return { report, observers };
}

afterEach(() => vi.unstubAllGlobals());

describe('visibility gate', () => {
    it('is covered until the panel has been visible for the minimum time', () => {
        const { report } = installV2();
        let t = 0;
        const gate = createVisibilityGate({} as Element, () => t);
        expect(gate.state()).toBe('covered');
        report(true);
        t = MIN_VISIBLE_MS - 1;
        expect(gate.state()).toBe('covered');
        t = MIN_VISIBLE_MS;
        expect(gate.state()).toBe('ok');
    });

    it('an overlay arriving resets it, and removing it just before a click is not enough', () => {
        const { report } = installV2();
        let t = 0;
        const gate = createVisibilityGate({} as Element, () => t);
        report(true);
        t = 1000;
        expect(gate.state()).toBe('ok');
        report(false); // the page lays something over the panel
        expect(gate.state()).toBe('covered');
        t = 1100;
        report(true); // ...and pulls it away
        t = 1200;
        expect(gate.state()).toBe('covered');
    });

    it('being hidden by the rail resets it, and being shown observes again for a fresh reading', () => {
        const { report, observers } = installV2();
        let t = 0;
        const gate = createVisibilityGate({} as Element, () => t);
        report(true);
        t = 1000;
        gate.setShown(false);
        expect(gate.state()).toBe('covered');
        gate.setShown(true);
        expect(observers[0]!.observed).toBe(2);
    });

    it('without IntersectionObserver v2 it says so, and the caller confirms instead', () => {
        vi.stubGlobal('IntersectionObserverEntry', class {});
        expect(createVisibilityGate({} as Element).state()).toBe('unsupported');
    });
});
