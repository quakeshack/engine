import { eventBus, getClientRegistry } from '../../registry.ts';
import type { MenuPage } from './MenuPage.ts';

// Destructure registry modules
let { IN, M } = getClientRegistry();

// Update when registry is frozen
eventBus.subscribe('registry.frozen', () => {
  ({ IN, M } = getClientRegistry());
});

/**
 * Stack-based menu navigation system.
 */
export class MenuStack {
  stack: MenuPage[];
  pages: Map<string, MenuPage>;
  #rootPageName: string | null = null;

  constructor() {
    this.stack = [];
    this.pages = new Map();
  }

  /**
   * Register a named page.
   */
  register(name: string, page: MenuPage): void {
    this.pages.set(name, page);
    eventBus.publish('menu.page-registered', name);
  }

  /**
   * Unregister a previously registered page by name.
   */
  unregister(name: string): void {
    this.pages.delete(name);
  }

  /**
   * Look up a registered page by name.
   * @returns The page, or undefined if nothing is registered under that name.
   */
  getPage(name: string): MenuPage | undefined {
    return this.pages.get(name);
  }

  /**
   * Check whether the named page is the one currently on top of the stack.
   * @returns True when the named page is current.
   */
  isShowing(name: string): boolean {
    const page = this.pages.get(name);
    return page !== undefined && this.current() === page;
  }

  /**
   * Declare which registered page is "the root" -- resolved by name, not by reference, so
   * re-registering that name to a different page later (e.g. a mod overriding the built-in
   * main menu) keeps the root correct automatically without calling this again.
   */
  setRootPage(name: string): void {
    console.assert(this.pages.has(name), `MenuStack.setRootPage: unknown page "${name}"`);
    this.#rootPageName = name;
  }

  /**
   * Push the current root page (see setRootPage). Does not clear the stack itself -- callers
   * that want a fresh root should clear() first.
   */
  pushRoot(): void {
    console.assert(this.#rootPageName !== null, 'MenuStack.pushRoot: no root page set');
    this.push(this.#rootPageName!);
  }

  /**
   * Check whether the root page (see setRootPage) is the one currently on top of the stack.
   * @returns True when the root page is current.
   */
  isShowingRoot(): boolean {
    return this.#rootPageName !== null && this.isShowing(this.#rootPageName);
  }

  /**
   * Find the registered name for a page instance, if any.
   * @returns The name it is registered under, or `null` when unregistered.
   */
  #nameOf(page: MenuPage): string | null {
    for (const [name, candidate] of this.pages) {
      if (candidate === page) {
        return name;
      }
    }

    return null;
  }

  /**
   * Push a page onto the stack.
   */
  push(pageOrName: MenuPage | string): void {
    // Deactivate current page
    const current = this.current();
    if (current) {
      current.deactivate();
      eventBus.publish('menu.closed', this.#nameOf(current));
    }

    // Resolve page
    const page = typeof pageOrName === 'string' ? this.pages.get(pageOrName) ?? null : pageOrName;

    if (!page) {
      console.error('MenuStack: Page not found:', pageOrName);
      return;
    }

    // Push and activate
    this.stack.push(page);
    page.activate();
    M.entersound = true;
    // Release mouselook so the camera doesn't keep spinning from residual deltas while the menu
    // has focus (the browser only auto-releases pointer lock on Escape, not on our own state
    // changes, and the menu can also be reached via mouse click/bound commands).
    IN.ReleasePointerLock();
    eventBus.publish('menu.opened', this.#nameOf(page));
  }

  /**
   * Pop the current page.
   * @returns The popped page.
   */
  pop(): MenuPage | null {
    if (this.stack.length === 0) {
      return null;
    }

    const page = this.stack.pop()!;
    page.deactivate();
    eventBus.publish('menu.closed', this.#nameOf(page));

    // Activate new current page
    const current = this.current();
    if (current) {
      current.activate();
      M.entersound = true;
      eventBus.publish('menu.opened', this.#nameOf(current));
    }

    return page;
  }

  /**
   * Get current page without removing it.
   * @returns The current page or null if stack is empty.
   */
  current(): MenuPage | null {
    return this.stack.length > 0 ? this.stack[this.stack.length - 1] : null;
  }

  /**
   * The page one level below the current one on the stack, if any -- e.g. a dialog's own
   * backdrop wanting to draw whatever was open before it appeared.
   * @returns The previous page, or null if the current page is at (or below) the root.
   */
  getPreviousPage(): MenuPage | null {
    return this.stack.length > 1 ? this.stack[this.stack.length - 2] : null;
  }

  /**
   * Clear the entire stack.
   */
  clear(): void {
    while (this.stack.length > 0) {
      const page = this.stack.pop()!;
      page.deactivate();
      eventBus.publish('menu.closed', this.#nameOf(page));
    }
  }

  /**
   * Get stack depth.
   * @returns Number of pages in stack.
   */
  depth(): number {
    return this.stack.length;
  }

  /**
   * Check if stack is empty.
   * @returns True if stack has no pages.
   */
  isEmpty(): boolean {
    return this.stack.length === 0;
  }

  /**
   * Replace current page with a new one.
   */
  replace(pageOrName: MenuPage | string): void {
    if (this.stack.length > 0) {
      this.pop();
    }
    this.push(pageOrName);
  }

  /**
   * Pop to a specific page depth.
   */
  popTo(depth: number): void {
    while (this.stack.length > depth && this.stack.length > 0) {
      this.pop();
    }
  }

  /**
   * Pop to the root page (see `setRootPage`), leaving only the bottom of the stack.
   */
  popToRoot(): void {
    this.popTo(1);
  }
}
