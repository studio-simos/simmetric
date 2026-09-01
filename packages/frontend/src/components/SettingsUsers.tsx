// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { apiGet, apiPost, apiPut } from "../utils/api";
import { showSuccess, showError } from "../lib/toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import {
  Form,
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormMessage,
} from "@/components/ui/form";
import { useForm } from "react-hook-form";
import { getErrorMessage } from "../utils/errorUtils";

interface UserWithRoles {
  id: string;
  username: string;
  email: string;
  createdAt: string;
  roles: { id: string; name: string; isDefault: boolean; permissions?: string[] }[];
  permissions: string[];
}

interface RoleInfo {
  id: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  permissions: string[];
}

interface CreateUserFormValues {
  username: string;
  email: string;
  password: string;
  role: string;
}

interface ResetPasswordFormValues {
  newPassword: string;
}

export default function SettingsUsers() {
  const { t } = useTranslation();
  const [users, setUsers] = useState<UserWithRoles[]>([]);
  const [roles, setRoles] = useState<RoleInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  // Edit state
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const [editUsername, setEditUsername] = useState("");
  const [editEmail, setEditEmail] = useState("");
  const [editRoleId, setEditRoleId] = useState("");

  // Reset password state
  const [resettingUserId, setResettingUserId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const visibleRoles = roles;

  const createForm = useForm<CreateUserFormValues>({
    defaultValues: {
      username: "",
      email: "",
      password: "",
      role: "user",
    },
  });

  const resetForm = useForm<ResetPasswordFormValues>({
    defaultValues: { newPassword: "" },
  });

  const loadData = async () => {
    try {
      const [usersData, rolesData] = await Promise.all([
        apiGet<UserWithRoles[]>("/auth/users"),
        apiGet<RoleInfo[]>("/roles"),
      ]);
      setUsers(usersData);
      setRoles(rolesData);
    } catch {
      // fall back to empty
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleCreateUser = async (data: CreateUserFormValues) => {
    setCreating(true);
    try {
      await apiPost("/auth/admin-register", {
        username: data.username,
        email: data.email,
        password: data.password,
        role: data.role,
      });
      showSuccess(t("settings.users.createUserSuccess"));
      createForm.reset({ username: "", email: "", password: "", role: "user" });
      await loadData();
    } catch (err: unknown) {
      showError(getErrorMessage(err, t("settings.users.createUserFailed")));
    } finally {
      setCreating(false);
    }
  };

  const startEdit = (user: UserWithRoles) => {
    setEditingUserId(user.id);
    setEditUsername(user.username);
    setEditEmail(user.email);
    const primaryRole = user.roles[0];
    setEditRoleId(primaryRole?.id || "");
    setResettingUserId(null);
  };

  const cancelEdit = () => {
    setEditingUserId(null);
    setEditUsername("");
    setEditEmail("");
    setEditRoleId("");
  };

  const handleSaveEdit = async () => {
    if (!editingUserId) return;
    setSaving(true);
    try {
      await apiPut(`/users/${editingUserId}`, {
        username: editUsername,
        email: editEmail,
      });

      // Handle role change
      const user = users.find((u) => u.id === editingUserId);
      if (user) {
        const currentRoleIds = user.roles.map((r) => r.id);
        // Revoke all old roles
        for (const roleId of currentRoleIds) {
          const roleInfo = roles.find((r) => r.id === roleId);
          if (roleInfo) {
            await apiPost("/roles/revoke", { userId: editingUserId, roleId });
          }
        }
        // Assign new role
        if (editRoleId) {
          await apiPost("/roles/assign", { userId: editingUserId, roleId: editRoleId });
        }
      }

      showSuccess(t("settings.users.userUpdated"));
      setEditingUserId(null);
      await loadData();
    } catch (err: unknown) {
      showError(getErrorMessage(err, t("settings.users.updateUserFailed")));
    } finally {
      setSaving(false);
    }
  };

  const handleResetPassword = async (data: ResetPasswordFormValues) => {
    if (!resettingUserId || data.newPassword.length < 8) {
      showError(t("settings.users.passwordTooShort"));
      return;
    }
    setSaving(true);
    try {
      await apiPost("/auth/admin-reset-password", {
        userId: resettingUserId,
        newPassword: data.newPassword,
      });
      showSuccess(t("settings.users.passwordResetSuccess"));
      setResettingUserId(null);
      resetForm.reset({ newPassword: "" });
    } catch (err: unknown) {
      showError(getErrorMessage(err, t("settings.users.passwordResetFailed")));
    } finally {
      setSaving(false);
    }
  };

  const getPrimaryRole = (user: UserWithRoles) => {
    if (user.permissions.includes("admin:settings")) return "admin";
    return user.roles[0]?.name || "user";
  };

  if (loading) {
    return <div className="text-muted-foreground text-sm">{t("settings.users.loading")}</div>;
  }

  return (
    <div className="w-full space-y-6">
      <h3 className="text-lg font-medium text-foreground">
        {t("settings.users.title")}
      </h3>

      {/* Create User */}
      <div className="bg-card rounded-lg border border-border p-5">
        <h4 className="text-sm font-semibold text-foreground mb-4">
          {t("settings.users.createUser")}
        </h4>
        <Form {...createForm}>
          <form
            onSubmit={createForm.handleSubmit(handleCreateUser)}
            className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end"
          >
            <FormField
              control={createForm.control}
              name="username"
              render={({ field }) => (
                <FormItem className="flex-1 min-w-[180px]">
                  <FormLabel>{t("settings.users.usernameLabel")}</FormLabel>
                  <FormControl>
                    <Input
                      type="text"
                      required
                      minLength={3}
                      placeholder="johndoe"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={createForm.control}
              name="email"
              render={({ field }) => (
                <FormItem className="flex-1 min-w-[200px]">
                  <FormLabel>{t("settings.users.emailLabel")}</FormLabel>
                  <FormControl>
                    <Input
                      type="email"
                      required
                      placeholder="john@example.com"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={createForm.control}
              name="password"
              render={({ field }) => (
                <FormItem className="flex-1 min-w-[160px]">
                  <FormLabel>{t("settings.users.passwordLabel")}</FormLabel>
                  <FormControl>
                    <Input
                      type="password"
                      required
                      minLength={8}
                      placeholder={t("settings.users.passwordPlaceholder")}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={createForm.control}
              name="role"
              render={({ field }) => (
                <FormItem className="w-full sm:w-32">
                  <FormLabel>{t("settings.users.roleLabel")}</FormLabel>
                  <FormControl>
                    <Select
                      value={field.value}
                      onValueChange={(value) => field.onChange(value)}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {visibleRoles.map((r) => (
                          <SelectItem key={r.id} value={r.name}>
                            {r.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <Button type="submit" disabled={creating} size="sm" className="self-start sm:self-auto">
              {creating
                ? t("settings.users.creating")
                : t("settings.users.createButton")}
            </Button>
          </form>
        </Form>
      </div>

      {/* Users Table */}
      <div className="bg-card rounded-lg border border-input overflow-hidden">
        <div className="px-5 py-3 border-b border-input">
          <h4 className="text-sm font-semibold text-foreground">
            {t("settings.users.usersCount", { count: users.length })}
          </h4>
        </div>
        <Table className="min-w-max w-full">
            <TableHeader>
              <TableRow className="border-b border-input text-left text-muted-foreground">
                <TableHead className="px-5 py-2">
                  {t("settings.users.colUsername")}
                </TableHead>
                <TableHead className="px-5 py-2">
                  {t("settings.users.colEmail")}
                </TableHead>
                <TableHead className="px-5 py-2">
                  {t("settings.users.colRole")}
                </TableHead>
                <TableHead className="px-5 py-2">
                  {t("settings.users.colPermissions")}
                </TableHead>
                <TableHead className="px-5 py-2">
                  {t("settings.users.colCreated")}
                </TableHead>
                <TableHead className="px-5 py-2">
                  {t("settings.users.colActions")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.map((user) => {
                const primaryRole = getPrimaryRole(user);

                return (
                  <TableRow
                    key={user.id}
                    className="border-b border-input hover:bg-accent"
                  >
                    {editingUserId === user.id ? (
                      <>
                        <TableCell className="px-5 py-3">
                          <Input
                            type="text"
                            value={editUsername}
                            onChange={(e) => setEditUsername(e.target.value)}
                            className="w-full px-2 py-1 h-auto text-sm"
                            minLength={3}
                          />
                        </TableCell>
                        <TableCell className="px-5 py-3">
                          <Input
                            type="email"
                            value={editEmail}
                            onChange={(e) => setEditEmail(e.target.value)}
                            className="w-full px-2 py-1 h-auto text-sm"
                          />
                        </TableCell>
                        <TableCell className="px-5 py-3">
                          <Select
                            value={editRoleId}
                            onValueChange={(value) => setEditRoleId(value)}
                          >
                            <SelectTrigger className="w-full px-2 py-1 h-auto text-sm">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {visibleRoles.map((r) => (
                                <SelectItem key={r.id} value={r.id}>
                                  {r.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </TableCell>
                        <TableCell className="px-5 py-3 text-muted-foreground text-xs">
                          {user.permissions.slice(0, 3).join(", ")}
                          {user.permissions.length > 3 &&
                            ` +${user.permissions.length - 3}`}
                        </TableCell>
                        <TableCell className="px-5 py-3 text-muted-foreground text-xs">
                          {new Date(user.createdAt).toLocaleDateString()}
                        </TableCell>
                        <TableCell className="px-5 py-3">
                          <div className="flex gap-2">
                            <Button
                              variant="link"
                              size="sm"
                              onClick={handleSaveEdit}
                              disabled={saving}
                            >
                              {saving ? t("common.saving") : t("common.save")}
                            </Button>
                            <Button
                              variant="link"
                              size="sm"
                              onClick={cancelEdit}
                            >
                              {t("common.cancel")}
                            </Button>
                          </div>
                        </TableCell>
                      </>
                    ) : (
                      <>
                        <TableCell className="px-5 py-3 font-medium text-foreground">
                          {user.username}
                        </TableCell>
                        <TableCell className="px-5 py-3 text-muted-foreground">
                          {user.email}
                        </TableCell>
                        <TableCell className="px-5 py-3">
                          <Badge
                            variant={
                              primaryRole === "admin" ? "default" : "outline"
                            }
                            className="text-xs"
                          >
                            {primaryRole}
                          </Badge>
                        </TableCell>
                        <TableCell className="px-5 py-3 text-muted-foreground text-xs">
                          {user.permissions.slice(0, 3).join(", ")}
                          {user.permissions.length > 3 &&
                            ` +${user.permissions.length - 3}`}
                        </TableCell>
                        <TableCell className="px-5 py-3 text-muted-foreground text-xs">
                          {new Date(user.createdAt).toLocaleDateString()}
                        </TableCell>
                        <TableCell className="px-5 py-3">
                          <div className="flex gap-2">
                            <Button
                              variant="link"
                              size="sm"
                              onClick={() => startEdit(user)}
                            >
                              {t("common.edit")}
                            </Button>
                            <Button
                              variant="link"
                              size="sm"
                              onClick={() => {
                                setResettingUserId(user.id);
                                resetForm.reset({ newPassword: "" });
                              }}
                              className="text-yellow-600 dark:text-yellow-400"
                            >
                              {t("settings.users.resetPassword")}
                            </Button>
                          </div>
                        </TableCell>
                      </>
                    )}
                  </TableRow>
                );
              })}
              {users.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    className="px-5 py-8 text-center text-muted-foreground"
                  >
                    {t("settings.users.noUsers")}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
      </div>

      {/* Reset Password Dialog */}
      <Dialog
        open={!!resettingUserId}
        onOpenChange={(open) => {
          if (!open) {
            setResettingUserId(null);
            resetForm.reset({ newPassword: "" });
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("settings.users.resetPasswordTitle")}</DialogTitle>
          </DialogHeader>
          <p className="text-xs text-muted-foreground">
            {t("settings.users.resetPasswordDescription", {
              username: users.find((u) => u.id === resettingUserId)?.username,
            })}
          </p>
          <Form {...resetForm}>
            <form
              onSubmit={resetForm.handleSubmit(handleResetPassword)}
              className="space-y-4"
            >
              <FormField
                control={resetForm.control}
                name="newPassword"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("settings.users.newPassword")}</FormLabel>
                    <FormControl>
                      <Input
                        type="password"
                        minLength={8}
                        placeholder={t("settings.users.newPasswordPlaceholder")}
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <DialogFooter>
                <Button
                  type="submit"
                  size="sm"
                  disabled={
                    saving || (resetForm.watch("newPassword")?.length || 0) < 8
                  }
                >
                  {saving
                    ? t("settings.users.resetting")
                    : t("settings.users.resetPasswordButton")}
                </Button>
                <DialogClose asChild>
                  <Button variant="ghost" size="sm">
                    {t("common.cancel")}
                  </Button>
                </DialogClose>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      {/* Roles Reference */}
      <div className="bg-card rounded-lg border border-input p-5">
        <h4 className="text-sm font-semibold text-foreground mb-3">
          {t("settings.users.availableRoles")}
        </h4>
        <div className="space-y-2">
          {visibleRoles.map((role) => (
            <div key={role.id} className="flex items-center gap-3 text-sm">
              <Badge
                variant={role.name === "admin" ? "default" : "outline"}
                className="text-xs"
              >
                {role.name}
              </Badge>
              <span className="text-muted-foreground">{t(`roles.${role.name}.description`, role.description ?? "")}</span>
              {role.isDefault && (
                <span className="text-xs bg-muted text-muted-foreground px-2 py-0.5 rounded">
                  {t("settings.users.defaultBadge")}
                </span>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
