import {
  Box,
  Bug,
  Clapperboard,
  Code,
  Flame,
  FlaskConical,
  Gamepad2,
  Gem,
  Image as ImageIcon,
  LayoutPanelTop,
  Map as MapIcon,
  Megaphone,
  Music,
  Palette,
  PersonStanding,
  Rocket,
  Scale,
  Shield,
  Sparkles,
  Swords,
  Trophy,
  Users,
  Wrench,
  Zap,
  Columns3,
  type LucideIcon,
} from "lucide-react";
import type { ColumnIconName } from "@/lib/column-icons";
import { cn } from "@/lib/utils";

export const COLUMN_ICON_COMPONENTS: Record<ColumnIconName, LucideIcon> = {
  sparkles: Sparkles,
  "person-standing": PersonStanding,
  box: Box,
  "layout-panel-top": LayoutPanelTop,
  code: Code,
  map: MapIcon,
  scale: Scale,
  megaphone: Megaphone,
  music: Music,
  bug: Bug,
  image: ImageIcon,
  clapperboard: Clapperboard,
  palette: Palette,
  swords: Swords,
  shield: Shield,
  trophy: Trophy,
  gem: Gem,
  flame: Flame,
  zap: Zap,
  users: Users,
  wrench: Wrench,
  "flask-conical": FlaskConical,
  "gamepad-2": Gamepad2,
  rocket: Rocket,
};

export function ColumnIcon({ name, color, className }: { name: string | null; color?: string | null; className?: string }) {
  const Icon = (name && COLUMN_ICON_COMPONENTS[name as ColumnIconName]) || Columns3;
  return <Icon className={cn("size-4 shrink-0", className)} style={{ color: color ?? "var(--fg-subtle)" }} aria-hidden />;
}
