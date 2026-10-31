import {
  Bug,
  FileImage,
  FileSpreadsheet,
  FileText,
  Globe,
  LayoutDashboard,
  type LucideIcon,
  NotebookText,
  PenTool,
  Presentation,
} from "lucide-react";
import type { MakeKind } from "../../lib/make";

const ICONS: Record<MakeKind, LucideIcon> = {
  page: Globe,
  dashboard: LayoutDashboard,
  slides: Presentation,
  doc: NotebookText,
  design: PenTool,
  file: FileText,
  bug: Bug,
};

/** A kind's icon. A saved file's follows its type (a picture, a spreadsheet, anything else). */
export function KindIcon({ kind, mime, className }: { kind: MakeKind; mime?: string; className?: string }) {
  const Icon =
    kind === "file" && mime?.startsWith("image/")
      ? FileImage
      : kind === "file" && mime && /csv|xls|sheet/.test(mime)
        ? FileSpreadsheet
        : ICONS[kind];
  return <Icon className={className} aria-hidden />;
}
