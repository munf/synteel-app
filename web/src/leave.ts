// A screen with work not yet saved can hold navigation (tabs, back buttons) and ask first.
// It gets the move to make once the farmer chooses to leave; returning true means it is asking.
type Hold = (leave: () => void) => boolean;
let hold: Hold | null = null;

export const holdLeave = (h: Hold | null) => {
  hold = h;
};

/** True when the current screen took over: the caller must not move now. */
export const leaveHeld = (leave: () => void) => hold?.(leave) ?? false;
