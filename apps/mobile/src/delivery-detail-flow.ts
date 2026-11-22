export type DetailAction = 'check_in' | 'photo' | 'note' | 'problem' | 'completion';

/** Only successful completion is allowed to leave the delivery detail route. */
export function shouldLeaveDetail(action: DetailAction, succeeded: boolean): boolean {
  return action === 'completion' && succeeded;
}

export function canComplete(hasCheckIn: boolean, photoCount: number): boolean {
  return hasCheckIn && photoCount > 0;
}
