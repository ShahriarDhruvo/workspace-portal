// The portal's icons: lucide-react (as in the Web Shell), 16px with a thin 1.5 stroke, in currentColor.
// Import icons from here rather than from lucide-react so size, stroke and aria-hidden stay consistent across
// the app's own components (the shadcn/ui primitives import theirs as the registry has them). Icons are
// decorative (aria-hidden) unless given an aria-label.
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CircleAlert,
  CircleCheck,
  CircleSlash,
  CircleX,
  Copy,
  Ellipsis,
  Eye,
  House,
  KeyRound,
  LogOut,
  Menu,
  Moon,
  LayoutDashboard,
  Package,
  Play,
  Plus,
  RefreshCw,
  ScrollText,
  Settings,
  Shield,
  Square,
  SquarePen,
  SquareTerminal,
  Sun,
  Trash2,
  UserCheck,
  Users,
  UserX,
  X,
  type LucideIcon,
  type LucideProps,
} from "lucide-react";

export type IconProps = LucideProps;

function icon(Glyph: LucideIcon, name: string) {
  function Icon({ size = 16, strokeWidth = 1.5, ...props }: IconProps) {
    const decorative = props["aria-label"] === undefined;
    return (
      <Glyph size={size} strokeWidth={strokeWidth} aria-hidden={decorative || undefined} focusable="false" {...props} />
    );
  }
  Icon.displayName = name;
  return Icon;
}

export const PlusIcon = icon(Plus, "PlusIcon");
export const EllipsisIcon = icon(Ellipsis, "EllipsisIcon");
export const MenuIcon = icon(Menu, "MenuIcon");
export const CloseIcon = icon(X, "CloseIcon");
export const CheckIcon = icon(Check, "CheckIcon");
export const ChevronDownIcon = icon(ChevronDown, "ChevronDownIcon");
export const ChevronUpIcon = icon(ChevronUp, "ChevronUpIcon");
export const ChevronRightIcon = icon(ChevronRight, "ChevronRightIcon");
export const CopyIcon = icon(Copy, "CopyIcon");
export const EditIcon = icon(SquarePen, "EditIcon");
export const TrashIcon = icon(Trash2, "TrashIcon");
export const RefreshIcon = icon(RefreshCw, "RefreshIcon");
export const WarningIcon = icon(CircleAlert, "WarningIcon");
export const ShieldIcon = icon(Shield, "ShieldIcon");
export const UsersIcon = icon(Users, "UsersIcon");
export const RightUpIcon = icon(ArrowUpRight, "RightUpIcon");
export const BackIcon = icon(ChevronLeft, "BackIcon");
export const LogOutIcon = icon(LogOut, "LogOutIcon");
export const TerminalIcon = icon(SquareTerminal, "TerminalIcon");
export const AuditIcon = icon(ScrollText, "AuditIcon");
export const KeyIcon = icon(KeyRound, "KeyIcon");
export const StopIcon = icon(Square, "StopIcon");
export const UserCheckIcon = icon(UserCheck, "UserCheckIcon");
export const UserXIcon = icon(UserX, "UserXIcon");
export const EyeIcon = icon(Eye, "EyeIcon");
export const PackageIcon = icon(Package, "PackageIcon");
export const OverviewIcon = icon(LayoutDashboard, "OverviewIcon");
export const SuccessIcon = icon(CircleCheck, "SuccessIcon");
export const FailedIcon = icon(CircleX, "FailedIcon");
export const CancelledIcon = icon(CircleSlash, "CancelledIcon");
export const HomeIcon = icon(House, "HomeIcon");
export const SettingsIcon = icon(Settings, "SettingsIcon");
export const SunIcon = icon(Sun, "SunIcon");
export const MoonIcon = icon(Moon, "MoonIcon");
export const PlayIcon = icon(Play, "PlayIcon");
export const ArrowRightIcon = icon(ArrowRight, "ArrowRightIcon");
