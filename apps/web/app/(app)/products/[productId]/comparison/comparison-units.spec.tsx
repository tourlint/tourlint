import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MetricTable, formatMetric } from "./comparison-view";

describe("수정 전후 비교 — 이동시간 · 거리의 단위 (#726)", () => {
  it("🔴 분은 시간 · 분으로, 미터는 km 로 적는다", () => {
    expect(formatMetric("travelMinutes", 189)).toBe("3시간 9분");
    expect(formatMetric("travelMinutes", 120)).toBe("2시간");
    expect(formatMetric("travelMinutes", 24)).toBe("24분");
    expect(formatMetric("travelMinutes", 0)).toBe("0분");
    expect(formatMetric("travelMeters", 122307)).toBe("122.3km");
    expect(formatMetric("travelMeters", 140000)).toBe("140.0km");
    expect(formatMetric("travelMeters", 400)).toBe("400m");
  });

  it("건수 · 점수는 그대로 두고, 없는 값은 - 다", () => {
    expect(formatMetric("blocker", 2)).toBe("2");
    expect(formatMetric("readinessScore", 85)).toBe("85");
    expect(formatMetric("travelMinutes", null)).toBe("-");
  });

  it("🔴 표의 전 · 후 · 변화 칸이 모두 같은 단위로 나온다", () => {
    const html = renderToStaticMarkup(
      <MetricTable
        metrics={[
          { key: "travelMinutes", label: "총 이동시간", before: 189, after: 213 },
          { key: "travelMeters", label: "총 이동거리", before: 122307, after: 140418 },
        ]}
      />,
    );
    expect(html).toContain("3시간 9분");
    expect(html).toContain("3시간 33분");
    expect(html).toContain("▲ 24분");
    expect(html).toContain("122.3km");
    expect(html).toContain("▲ 18.1km");
    expect(html).not.toContain("122307");
  });
});
