import React from "react";
import {
  AlertCircleIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUpRightIcon,
  BookIcon,
  ChatIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ClockIcon,
  CloseIcon,
  CloudIcon,
  CodeIcon,
  DownloadIcon,
  EllipsisIcon,
  ExternalLinkIcon,
  FileIcon,
  FolderIcon,
  GlobeIcon,
  GridIcon,
  ImageIcon,
  InfoIcon,
  LeafIcon,
  LinkIcon,
  ListIcon,
  MaximizeIcon,
  MenuIcon,
  MoonIcon,
  PaintbrushIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  RedoIcon,
  RefreshIcon,
  SaveIcon,
  SearchIcon,
  SettingsIcon,
  ShieldIcon,
  SortIcon,
  SpinnerIcon,
  StarIcon,
  SunIcon,
  TagIcon,
  TrashIcon,
  UndoIcon,
  UploadIcon,
  ZoomInIcon,
  ZoomOutIcon,
  type IconComponent,
  type IconProps,
} from "naive-icons";

// Keep library defaults consistent across controls while retaining its painted fills.
function icon(Component: IconComponent) {
  return function Icon({ title, ...props }: IconProps) {
    return (
      <Component
        color="currentColor"
        aria-hidden={title ? undefined : true}
        focusable="false"
        title={title}
        {...props}
      />
    );
  };
}

export const AlertCircle = icon(AlertCircleIcon);

export const ArrowLeft = icon(ArrowLeftIcon);

export const ArrowUpRight = icon(ArrowUpRightIcon);

export const BookOpen = icon(BookIcon);

export const Check = icon(CheckIcon);

export const ChevronDown = icon(ChevronDownIcon);

export const ChevronLeft = icon(ChevronLeftIcon);

export const ChevronRight = icon(ChevronRightIcon);

export const ChevronsUpDown = icon(SortIcon);

export const Clock = icon(ClockIcon);

export const Cloud = icon(CloudIcon);

export const Download = icon(DownloadIcon);

export const ExternalLink = icon(ExternalLinkIcon);

export const File = icon(FileIcon);

export const FileCode = icon(CodeIcon);

export const FileText = icon(FileIcon);

export const Folder = icon(FolderIcon);

export const FolderOpen = icon(FolderIcon);

export const FolderPlus = icon(FolderIcon);

export const Globe = icon(GlobeIcon);

export const HardDrive = icon(SaveIcon);

export const HardDriveDownload = icon(DownloadIcon);

export const Hash = icon(TagIcon);

export const Highlighter = icon(PaintbrushIcon);

export const History = icon(ClockIcon);

export const Image = icon(ImageIcon);

export const Info = icon(InfoIcon);

export const Leaf = icon(LeafIcon);

export const Link2 = icon(LinkIcon);

export const LoaderCircle = icon(SpinnerIcon);

export const Maximize = icon(MaximizeIcon);

export const Maximize2 = icon(MaximizeIcon);

export const Moon = icon(MoonIcon);

export const MoreHorizontal = icon(EllipsisIcon);

export const Move = icon(ArrowRightIcon);

export const MoveHorizontal = icon(MaximizeIcon);

export const PanelLeft = icon(MenuIcon);

export const PanelRight = icon(ListIcon);

export const PenLine = icon(PencilIcon);

export const Play = icon(PlayIcon);

export const Plus = icon(PlusIcon);

export const Puzzle = icon(GridIcon);

export const RefreshCw = icon(RefreshIcon);

export const RotateCcw = icon(UndoIcon);

export const RotateCw = icon(RedoIcon);

export const Save = icon(SaveIcon);

export const Search = icon(SearchIcon);

export const Settings = icon(SettingsIcon);

export const ShieldCheck = icon(ShieldIcon);

export const Sparkles = icon(StarIcon);

export const Star = icon(StarIcon);

export const StickyNote = icon(ChatIcon);

export const Sun = icon(SunIcon);

export const Trash2 = icon(TrashIcon);

export const Upload = icon(UploadIcon);

export const X = icon(CloseIcon);

export const ZoomIn = icon(ZoomInIcon);

export const ZoomOut = icon(ZoomOutIcon);
