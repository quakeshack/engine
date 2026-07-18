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
   * Pop to root (main menu).
   */
  popToRoot(): void {
    this.popTo(1);
  }
}
