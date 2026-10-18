import type { Request, RequestHandler } from 'express';
import { authorize, type Action, type ResourceContext, type Role } from '../auth/policy';
import { forbidden, unauthorized } from '../http/errors';

/**
 * RBAC middleware. These run AFTER `requireAuth` (which sets `req.principal`); if the principal
 * is missing they fail closed with a 401. The role gate and the policy check are the server-side
 * enforcement point — never the UI.
 */

/** Allow the request only if the principal holds at least one of `roles`. */
export function requireRole(...roles: Role[]): RequestHandler {
  return (req, _res, next) => {
    const principal = req.principal;
    if (!principal) {
      next(unauthorized('Authentication required'));
      return;
    }
    if (roles.some((role) => principal.roles.includes(role))) {
      next();
      return;
    }
    next(forbidden());
  };
}

/**
 * Allow the request only if the policy permits `action` on the resolved resource. `resolveResource`
 * loads the resource (e.g. the order) so its ownership fields can be checked.
 */
export function requirePolicy(
  action: Action,
  resolveResource?: (req: Request) => ResourceContext | Promise<ResourceContext>,
): RequestHandler {
  return (req, _res, next) => {
    const principal = req.principal;
    if (!principal) {
      next(unauthorized('Authentication required'));
      return;
    }
    Promise.resolve(resolveResource ? resolveResource(req) : undefined)
      .then((resource) => {
        authorize(principal, action, resource);
        next();
      })
      .catch(next);
  };
}
