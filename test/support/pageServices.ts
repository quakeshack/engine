import * as services from '../../source/engine/client/PageServices.ts';

type ServiceName = 'COM' | 'NET' | 'urls' | 'buildConfig';

/**
 * Stands in for the registry entries of the services of the page in tests that mock them: reading gives what is
 * installed, assigning installs it (`null` or a mock, so that a test can put back what it found).
 */
export const pageServices = new Proxy({} as Record<ServiceName, unknown>, {
  get(_target, name) {
    switch (name as ServiceName) {
      case 'COM':
        return services.com;
      case 'NET':
        return services.net;
      case 'urls':
        return services.urls;
      default:
        return services.buildConfig;
    }
  },
  set(_target, name, value) {
    const installed = value as never;

    switch (name as ServiceName) {
      case 'COM':
        services.installPageServices({ com: installed });
        break;
      case 'NET':
        services.installPageServices({ net: installed });
        break;
      case 'urls':
        services.installPageServices({ urls: installed });
        break;
      default:
        services.installPageServices({ buildConfig: installed });
        break;
    }

    return true;
  },
});
