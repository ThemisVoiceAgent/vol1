import type { Request, Response, NextFunction } from "express";
import { config } from "../config.js";

export function invalidTokenResponse() {
  return {
    status: "error" as const,
    message: "Invalid or missing API token",
    data: {},
  };
}

export function validateThemisApiToken(req: Request): boolean {
  const token = req.header("X-API-Token") || req.header("x-api-token") || "";
  const expected = config.themis.apiToken;
  if (!expected || !token || token !== expected) {
    return false;
  }
  return true;
}

export function requireThemisApiToken(req: Request, res: Response, next: NextFunction): void {
  if (!validateThemisApiToken(req)) {
    res.status(401).json(invalidTokenResponse());
    return;
  }
  next();
}
