/**
 * Refuses a click on the panel while the page may be covering it (hardening H4,
 * spec R18, D2).
 *
 * The panel is an iframe on a site someone else controls. That site cannot read
 * it, but it can lay its own element over it — transparent, or dressed as
 * something else — and let a click fall through (`pointer-events: none`) onto
 * "Switch" or "Report". IntersectionObserver v2 (`trackVisibility`) asks the
 * browser whether the panel is actually unoccluded, untransformed and opaque.
 *
 * A click counts only once the panel has been visible, continuously, for
 * `MIN_VISIBLE_MS`: the classic trick is to remove the overlay a moment before
 * the click, and the browser reports visibility at most every 100 ms.
 *
 * Where v2 is missing (non-Chromium), `state()` says `unsupported` and the
 * caller falls back to a confirm step.
 */

export const MIN_VISIBLE_MS = 500;

export type GateState = 'ok' | 'covered' | 'unsupported';

export interface VisibilityGate {
    state(): GateState;
    /**
     * What the rail says about the panel. A display:none cross-origin frame gets
     * no observer update while hidden, and may get none when shown again either,
     * so being shown re-observes to force a fresh reading.
     */
    setShown(shown: boolean): void;
}

interface V2Entry {
    isVisible?: boolean;
}

export function createVisibilityGate(target: Element, now: () => number = () => performance.now(), onReading?: (visible: boolean) => void): VisibilityGate {
    const supported = typeof IntersectionObserverEntry !== 'undefined' && 'isVisible' in IntersectionObserverEntry.prototype;
    let visibleSince: number | null = null;
    let io: IntersectionObserver | null = null;

    if (supported) {
        io = new IntersectionObserver(
            (entries) => {
                for (const e of entries) {
                    const visible = (e as IntersectionObserverEntry & V2Entry).isVisible === true;
                    onReading?.(visible);
                    if (!visible) visibleSince = null;
                    else if (visibleSince === null) visibleSince = now();
                }
            },
            // `trackVisibility` needs a delay of at least 100 ms.
            { trackVisibility: true, delay: 100 } as IntersectionObserverInit
        );
        io.observe(target);
    }

    return {
        state(): GateState {
            if (!supported) return 'unsupported';
            return visibleSince !== null && now() - visibleSince >= MIN_VISIBLE_MS ? 'ok' : 'covered';
        },
        setShown(shown: boolean): void {
            visibleSince = null;
            if (shown && io) {
                io.disconnect();
                io.observe(target);
            }
        },
    };
}
