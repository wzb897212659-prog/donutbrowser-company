import type { Request } from "express";

export type Role = "super_admin" | "admin";

export type AuthUser = {
  id: string;
  username: string;
  role: Role;
  tokenVersion: number;
};

export type AuthenticatedRequest = Request & { authUser?: AuthUser };

export type ProfileAccessAction = "read" | "write" | "delete" | "list";
