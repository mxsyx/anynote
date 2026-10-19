import React from "react";
import {
  AlertCircle as AlertCircleIcon,
  ArrowLeft as ArrowLeftIcon,
  ArrowUpRight as ArrowUpRightIcon,
  BookOpen as BookOpenIcon,
  Check as CheckIcon,
  ChevronDown as ChevronDownIcon,
  ChevronLeft as ChevronLeftIcon,
  ChevronRight as ChevronRightIcon,
  ChevronsUpDown as ChevronsUpDownIcon,
  Clock as ClockIcon,
  Cloud as CloudIcon,
  Download as DownloadIcon,
  ExternalLink as ExternalLinkIcon,
  File as FileIcon,
  FileCode as FileCodeIcon,
  FileText as FileTextIcon,
  Folder as FolderIcon,
  FolderOpen as FolderOpenIcon,
  FolderPlus as FolderPlusIcon,
  Globe as GlobeIcon,
  HardDrive as HardDriveIcon,
  HardDriveDownload as HardDriveDownloadIcon,
  Hash as HashIcon,
  Highlighter as HighlighterIcon,
  History as HistoryIcon,
  Image as ImageIcon,
  Info as InfoIcon,
  Leaf as LeafIcon,
  Link2 as Link2Icon,
  LoaderCircle as LoaderCircleIcon,
  Maximize as MaximizeIcon,
  Maximize2 as Maximize2Icon,
  Moon as MoonIcon,
  MoreHorizontal as MoreHorizontalIcon,
  Move as MoveIcon,
  MoveHorizontal as MoveHorizontalIcon,
  PanelLeft as PanelLeftIcon,
  PanelRight as PanelRightIcon,
  PenLine as PenLineIcon,
  Play as PlayIcon,
  Plus as PlusIcon,
  Puzzle as PuzzleIcon,
  RefreshCw as RefreshCwIcon,
  RotateCcw as RotateCcwIcon,
  RotateCw as RotateCwIcon,
  Save as SaveIcon,
  Search as SearchIcon,
  Settings as SettingsIcon,
  ShieldCheck as ShieldCheckIcon,
  Sparkles as SparklesIcon,
  Star as StarIcon,
  StickyNote as StickyNoteIcon,
  Sun as SunIcon,
  Trash2 as Trash2Icon,
  Upload as UploadIcon,
  X as XIcon,
  ZoomIn as ZoomInIcon,
  ZoomOut as ZoomOutIcon,
  type LucideIcon,
  type LucideProps,
} from "lucide-react";

// Keep library defaults consistent across controls, with inherited ink color.
function icon(Component: LucideIcon) {
  return function Icon(props: LucideProps) {
    return (
      <Component
        aria-hidden="true"
        focusable="false"
        strokeWidth={1.6}
        {...props}
      />
    );
  };
}

export const AlertCircle = icon(AlertCircleIcon);

export const ArrowLeft = icon(ArrowLeftIcon);

export const ArrowUpRight = icon(ArrowUpRightIcon);

export const BookOpen = icon(BookOpenIcon);

export const Check = icon(CheckIcon);

export const ChevronDown = icon(ChevronDownIcon);

export const ChevronLeft = icon(ChevronLeftIcon);

export const ChevronRight = icon(ChevronRightIcon);

export const ChevronsUpDown = icon(ChevronsUpDownIcon);

export const Clock = icon(ClockIcon);

export const Cloud = icon(CloudIcon);

export const Download = icon(DownloadIcon);

export const ExternalLink = icon(ExternalLinkIcon);

export const File = icon(FileIcon);

export const FileCode = icon(FileCodeIcon);

export const FileText = icon(FileTextIcon);

export const Folder = icon(FolderIcon);

export const FolderOpen = icon(FolderOpenIcon);

export const FolderPlus = icon(FolderPlusIcon);

export const Globe = icon(GlobeIcon);

export const HardDrive = icon(HardDriveIcon);

export const HardDriveDownload = icon(HardDriveDownloadIcon);

export const Hash = icon(HashIcon);

export const Highlighter = icon(HighlighterIcon);

export const History = icon(HistoryIcon);

export const Image = icon(ImageIcon);

export const Info = icon(InfoIcon);

export const Leaf = icon(LeafIcon);

export const Link2 = icon(Link2Icon);

export const LoaderCircle = icon(LoaderCircleIcon);

export const Maximize = icon(MaximizeIcon);

export const Maximize2 = icon(Maximize2Icon);

export const Moon = icon(MoonIcon);

export const MoreHorizontal = icon(MoreHorizontalIcon);

export const Move = icon(MoveIcon);

export const MoveHorizontal = icon(MoveHorizontalIcon);

export const PanelLeft = icon(PanelLeftIcon);

export const PanelRight = icon(PanelRightIcon);

export const PenLine = icon(PenLineIcon);

export const Play = icon(PlayIcon);

export const Plus = icon(PlusIcon);

export const Puzzle = icon(PuzzleIcon);

export const RefreshCw = icon(RefreshCwIcon);

export const RotateCcw = icon(RotateCcwIcon);

export const RotateCw = icon(RotateCwIcon);

export const Save = icon(SaveIcon);

export const Search = icon(SearchIcon);

export const Settings = icon(SettingsIcon);

export const ShieldCheck = icon(ShieldCheckIcon);

export const Sparkles = icon(SparklesIcon);

export const Star = icon(StarIcon);

export const StickyNote = icon(StickyNoteIcon);

export const Sun = icon(SunIcon);

export const Trash2 = icon(Trash2Icon);

export const Upload = icon(UploadIcon);

export const X = icon(XIcon);

export const ZoomIn = icon(ZoomInIcon);

export const ZoomOut = icon(ZoomOutIcon);
