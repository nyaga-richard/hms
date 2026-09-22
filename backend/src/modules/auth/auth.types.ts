export interface AuthUser {
  id: string;
  username: string;
  full_name: string;
  email: string | null;
  is_superuser: boolean;
  default_property_id: string | null;
  department_id: string | null;
  employee_id: string | null;
  must_change_password: boolean;
  permissions: Set<string>;
  roles: { id: string; code: string; name: string }[];
  propertyIds: string[]; // empty = all properties
  limits: Record<string, number>;
  sessionId: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      propertyId?: string | null;
      token?: string;
    }
  }
}
export {};
