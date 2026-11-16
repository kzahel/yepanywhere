import { fireEvent } from "@testing-library/react";

/**
 * Clicks a link and returns whether the browser would follow it, meaning no
 * handler prevented the default. jsdom cannot navigate; left uncancelled, it
 * reports "Not implemented: navigation" from a timer that fires in whichever
 * test runs next. The cancel runs at the document, after the page's handlers.
 */
export function clickLink(link: Element, init?: MouseEventInit): boolean {
  let follows = false;
  const cancel = (event: Event) => {
    follows = !event.defaultPrevented;
    event.preventDefault();
  };
  link.ownerDocument.addEventListener("click", cancel);
  try {
    fireEvent.click(link, init);
  } finally {
    link.ownerDocument.removeEventListener("click", cancel);
  }
  return follows;
}
