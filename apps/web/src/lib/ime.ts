/** True when an Enter keydown is part of an IME composition (e.g. confirming Chinese input). */
export function isImeComposing(event: { nativeEvent: KeyboardEvent & { keyCode?: number } }): boolean {
  return event.nativeEvent.isComposing === true || event.nativeEvent.keyCode === 229
}
