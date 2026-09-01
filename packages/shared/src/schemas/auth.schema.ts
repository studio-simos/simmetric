// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { z } from "zod";

// ===== Auth Schemas =====

export const loginSchema = z.object({
  username: z.string().min(1, "Username is required").max(100),
  password: z.string().min(1, "Password is required"),
});

export const registerSchema = z.object({
  username: z
    .string()
    .min(3, "Username must be at least 3 characters")
    .max(100),
  email: z.string().email("Invalid email address"),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .max(128),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8).max(128),
});

export const setInitialPasswordSchema = z.object({
  newPassword: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .max(128),
});

export const adminRegisterSchema = z.object({
  username: z
    .string()
    .min(3, "Username must be at least 3 characters")
    .max(100),
  email: z.string().email("Invalid email address"),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .max(128),
  role: z.string().optional().default("user"),
});

export const adminResetPasswordSchema = z.object({
  userId: z.string().uuid("Invalid user ID"),
  newPassword: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .max(128),
});

export const updateUserSchema = z.object({
  username: z.string().min(3, "Username must be at least 3 characters").max(100).optional(),
  email: z.string().email("Invalid email address").optional(),
  password: z.string().min(8, "Password must be at least 8 characters").max(128).optional(),
  firstName: z.string().max(100, "First name must be at most 100 characters").optional(),
  lastName: z.string().max(100, "Last name must be at most 100 characters").optional(),
  customInstructions: z.string().max(4000, "Custom instructions must be at most 4000 characters").optional(),
  textSize: z.enum(["sm", "md", "lg"]).optional(),
});

export type LoginInput = z.infer<typeof loginSchema>;
export type RegisterInput = z.infer<typeof registerSchema>;
type AdminRegisterInput = z.infer<typeof adminRegisterSchema>;
type AdminResetPasswordInput = z.infer<typeof adminResetPasswordSchema>;
type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
type SetInitialPasswordInput = z.infer<typeof setInitialPasswordSchema>;
type UpdateUserInput = z.infer<typeof updateUserSchema>;