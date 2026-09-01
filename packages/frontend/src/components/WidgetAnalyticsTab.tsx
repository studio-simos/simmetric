// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useState } from "react";
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";
import { useTranslation } from "react-i18next";
import {
  useWidgets,
  useWidgetAnalyticsDaily,
  useWidgetTopics,
  useWidgetSummary,
} from "../queries/useWidgets";

import {
  Tabs,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";

const COLORS = ["#4c6ef5", "#37b24d", "#f59f00", "#e03131", "#7048e8", "#1098ad"];

type PeriodDays = 7 | 30 | 90;

export default function WidgetAnalyticsTab() {
  const { t } = useTranslation();
  const [selectedWidgetId, setSelectedWidgetId] = useState<string | undefined>(undefined);
  const [days, setDays] = useState<PeriodDays>(7);

  const { data: widgets = [] } = useWidgets();
  const {
    data: widgetAnalyticsDaily = [],
    isLoading: dailyLoading,
  } = useWidgetAnalyticsDaily(days, selectedWidgetId);
  const {
    data: widgetAnalyticsTopics = [],
    isLoading: topicsLoading,
  } = useWidgetTopics(days, selectedWidgetId);
  const {
    data: widgetAnalyticsSummary,
    isLoading: summaryLoading,
  } = useWidgetSummary(days, selectedWidgetId);

  const analyticsLoading = dailyLoading || topicsLoading || summaryLoading;

  if (analyticsLoading && widgetAnalyticsDaily.length === 0) {
    return (
      <div className="p-6 space-y-8">
        <div className="flex flex-wrap items-center gap-4">
          <Skeleton className="h-9 w-48" />
          <Skeleton className="h-9 w-32" />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
        <Skeleton className="h-[200px] w-full" />
      </div>
    );
  }

  const hasData =
    widgetAnalyticsDaily.length > 0 ||
    widgetAnalyticsTopics.length > 0 ||
    widgetAnalyticsSummary !== null;

  return (
    <div className="p-6 space-y-8">
      {/* Controls: Widget selector + Time range */}
      <div className="flex flex-wrap items-center gap-4">
        {/* Widget selector */}
        <Select
          value={selectedWidgetId ?? "all"}
          onValueChange={(value) => setSelectedWidgetId(value === "all" ? undefined : value)}
        >
          <SelectTrigger className="flex-1 min-w-[200px]">
            <SelectValue placeholder={t("analytics.allWidgets")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("analytics.allWidgets")}</SelectItem>
            {widgets.map((w) => (
              <SelectItem key={w.id} value={w.id}>
                {w.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Time range tabs */}
        <Tabs value={String(days)} onValueChange={(value) => setDays(Number(value) as PeriodDays)}>
          <TabsList>
            <TabsTrigger value="7">{t("analytics.last7Days")}</TabsTrigger>
            <TabsTrigger value="30">{t("analytics.last30Days")}</TabsTrigger>
            <TabsTrigger value="90">{t("analytics.last90Days")}</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {!hasData && (
        <div className="p-6 text-secondary-foreground text-center">
          {t("analytics.noAnalyticsData")}
        </div>
      )}

      {/* Summary cards */}
      {widgetAnalyticsSummary && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium text-muted-foreground">{t("analytics.conversations")}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-bold text-foreground">
                {widgetAnalyticsSummary.totalConversations.toLocaleString()}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium text-muted-foreground">{t("analytics.unansweredRate")}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-bold text-foreground">
                {(widgetAnalyticsSummary.unansweredRate * 100).toFixed(1)}%
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium text-muted-foreground">{t("analytics.qualityRate")}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-bold text-foreground">
                {(widgetAnalyticsSummary.qualityRate * 100).toFixed(1)}%
              </p>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Conversation count — Line Chart */}
      {widgetAnalyticsDaily.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>{t("analytics.conversations")}</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={widgetAnalyticsDaily}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="date" tick={{ fontSize: 12 }} />
                <YAxis tick={{ fontSize: 12 }} />
                <Tooltip />
                <Line
                  type="monotone"
                  dataKey="conversations"
                  stroke={COLORS[0]}
                  name={t("analytics.conversations")}
                  strokeWidth={2}
                />
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}

      {/* Topic distribution — Bar Chart */}
      {widgetAnalyticsTopics.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>{t("analytics.topicDistribution")}</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={widgetAnalyticsTopics}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="topic" tick={{ fontSize: 12 }} />
                <YAxis tick={{ fontSize: 12 }} />
                <Tooltip />
                <Bar dataKey="count" name={t("analytics.conversations")}>
                  {widgetAnalyticsTopics.map((_entry, index) => (
                    <Cell key={index} fill={COLORS[index % COLORS.length]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}

      {/* Unanswered rate + Quality rate — Line Chart */}
      {widgetAnalyticsDaily.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>
              {t("analytics.unansweredRate")} & {t("analytics.qualityRate")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={widgetAnalyticsDaily}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="date" tick={{ fontSize: 12 }} />
                <YAxis tick={{ fontSize: 12 }} tickFormatter={(v: number) => `${(v * 100).toFixed(0)}%`} />
                <Tooltip formatter={(value) => `${(Number(value) * 100).toFixed(1)}%`} />
                <Line
                  type="monotone"
                  dataKey="unansweredRate"
                  stroke={COLORS[3]}
                  name={t("analytics.unansweredRate")}
                  strokeWidth={2}
                />
                <Line
                  type="monotone"
                  dataKey="qualityRate"
                  stroke={COLORS[1]}
                  name={t("analytics.qualityRate")}
                  strokeWidth={2}
                />
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
