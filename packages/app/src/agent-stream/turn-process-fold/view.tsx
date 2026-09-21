import { memo, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { ExpandableBadge } from "@/components/message";
import { componentForToolCallIcon } from "@/utils/tool-call-icon";
import { buildTurnProcessLabel, type TurnProcessCounts, type TurnProcessFold } from "./model";

const TURN_PROCESS_ICON = componentForToolCallIcon("brain");

export function useTurnProcessLabel(counts: TurnProcessCounts): string {
  const { t } = useTranslation();
  return useMemo(() => buildTurnProcessLabel(t, counts), [counts, t]);
}

export const TurnProcessFoldView = memo(function TurnProcessFoldView({
  fold,
  expanded,
  isLastInSequence = false,
  onToggle,
}: {
  fold: TurnProcessFold;
  expanded: boolean;
  isLastInSequence?: boolean;
  onToggle: (foldId: string, expanded: boolean) => void;
}) {
  const label = useTurnProcessLabel(fold.counts);
  const handleToggle = useCallback(() => {
    onToggle(fold.host.id, !expanded);
  }, [expanded, fold.host.id, onToggle]);
  return (
    <ExpandableBadge
      testID="turn-process-fold"
      label={label}
      icon={TURN_PROCESS_ICON}
      isExpanded={expanded}
      isLastInSequence={isLastInSequence}
      onToggle={handleToggle}
    />
  );
});
