import { expect, type Locator } from "@playwright/test";

/** Captures styles at this focus step, before another keyboard action changes them. */
export async function focusedElement(locator: Locator) {
  await expect(locator).toBeFocused();
  return locator.evaluate((element) => ({
    focused: element === document.activeElement,
    focusVisible: element.matches(":focus-visible"),
    outline: getComputedStyle(element).outlineStyle,
  }));
}
