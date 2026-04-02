import type { BaseDriver } from './NetworkDrivers.ts';

/**
 * Manage network driver registration, lifecycle, and client-side selection.
 */
export class DriverRegistry {
  /** Registered drivers by name. */
  drivers: Record<string, BaseDriver> = {};
  /** Drivers in registration order for deterministic selection. */
  orderedDrivers: BaseDriver[] = [];

  /**
   * Register a network driver.
   * @param name
   * @param driver
   */
  register(name: string, driver: BaseDriver): void {
    this.drivers[name] = driver;
    this.orderedDrivers.push(driver);
  }

  /**
   * Get a driver by name.
   * @param name
   * @returns Registered driver or null when absent.
   */
  get(name: string): BaseDriver | null {
    return this.drivers[name] ?? null;
  }

  /**
   * Select the first initialized driver that can handle the address.
   * @param address
   * @returns Suitable driver or null when no driver can handle the address.
   */
  getClientDriver(address: string): BaseDriver | null {
    for (const driver of this.orderedDrivers) {
      if (driver.initialized && driver.canHandle(address)) {
        return driver;
      }
    }

    return null;
  }

  /**
   * Return all initialized drivers in registration order.
   * @returns Initialized drivers.
   */
  getInitializedDrivers(): BaseDriver[] {
    return this.orderedDrivers.filter((driver) => driver.initialized);
  }

  /** Initialize all registered drivers. */
  initialize(): void {
    for (const driver of this.orderedDrivers) {
      driver.Init();
    }
  }

  /** Shutdown all registered drivers. */
  shutdown(): void {
    for (const driver of this.orderedDrivers) {
      driver.Shutdown();
    }
  }
}
