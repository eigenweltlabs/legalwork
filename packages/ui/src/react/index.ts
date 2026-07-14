/* -------------------------------------------------------------------------- */
/* @legalwork/ui — React component library                                    */
/* -------------------------------------------------------------------------- */

/* utils */
export { cn } from "./utils/cn"

/* primitives */
export { Button, buttonVariants } from "./components/button"
export type { ButtonProps } from "./components/button"
export { IconButton } from "./components/icon-button"
export type { IconButtonProps } from "./components/icon-button"
export { Input } from "./components/input"
export type { InputProps } from "./components/input"
export { SearchInput } from "./components/search-input"
export { Textarea } from "./components/textarea"
export type { TextareaProps } from "./components/textarea"
export { Switch } from "./components/switch"
export type { SwitchProps } from "./components/switch"
export { SegmentedControl } from "./components/segmented-control"
export type { SegmentedControlProps, SegmentedItem } from "./components/segmented-control"
export { Card, CardHeader } from "./components/card"
export type { CardProps } from "./components/card"
export { Row } from "./components/row"
export type { RowProps } from "./components/row"
export { Divider } from "./components/divider"
export type { DividerProps } from "./components/divider"
export { Badge } from "./components/badge"
export type { BadgeProps } from "./components/badge"
export { Avatar } from "./components/avatar"
export type { AvatarProps } from "./components/avatar"
export { Kbd } from "./components/kbd"
export { Tabs } from "./components/tabs"
export type { TabsProps, TabItem } from "./components/tabs"
export {
  Menu,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  MenuSearch,
} from "./components/menu"
export type { MenuProps, MenuItemProps } from "./components/menu"
export { Select } from "./components/select"
export type { SelectProps, SelectOption } from "./components/select"

/* app-shaped components (batch 2) */
export { Tooltip } from "./components/tooltip"
export type { TooltipProps } from "./components/tooltip"
export { Slider } from "./components/slider"
export type { SliderProps } from "./components/slider"
export { Modal } from "./components/modal"
export type { ModalProps } from "./components/modal"
export { AppIcon } from "./components/app-icon"
export type { AppIconProps } from "./components/app-icon"
export { Sidebar, SidebarItem, SidebarGroup } from "./components/sidebar"
export type { SidebarProps, SidebarItemProps } from "./components/sidebar"
export { FileRow } from "./components/file-row"
export type { FileRowProps } from "./components/file-row"
export { ModelChip } from "./components/model-chip"
export type { ModelChipProps } from "./components/model-chip"
export { Composer } from "./components/composer"
export type { ComposerProps } from "./components/composer"
export { Toast, ToastProvider, useToast } from "./components/toast"
export type { ToastOptions } from "./components/toast"

/* gap components (batch 3 — from app migration inventory) */
export { Spinner, Dots } from "./components/spinner"
export type { SpinnerProps, DotsProps } from "./components/spinner"
export { Skeleton, SkeletonText } from "./components/skeleton"
export type { SkeletonProps, SkeletonTextProps } from "./components/skeleton"
export { Checkbox } from "./components/checkbox"
export type { CheckboxProps } from "./components/checkbox"
export { Progress } from "./components/progress"
export type { ProgressProps } from "./components/progress"
export { Alert } from "./components/alert"
export type { AlertProps } from "./components/alert"
export { Field, FieldRow } from "./components/form-field"
export type { FieldProps, FieldRowProps } from "./components/form-field"
export { ActionRow } from "./components/action-row"
export type { ActionRowProps } from "./components/action-row"
export { StatusDot } from "./components/status-dot"
export type { StatusDotProps } from "./components/status-dot"
export { Accordion, AccordionItem } from "./components/accordion"
export type { AccordionProps, AccordionItemProps } from "./components/accordion"
export { Table, THead, TBody, Tr, Th, Td } from "./components/data-table"
export type { TableProps, THeadProps, TBodyProps, TrProps, ThProps, TdProps } from "./components/data-table"
export { CodeBlock, InlineCode } from "./components/code-block"
export type { CodeBlockProps, InlineCodeProps } from "./components/code-block"
export { ConfirmModal } from "./components/confirm-modal"
export type { ConfirmModalProps } from "./components/confirm-modal"

/* paper shaders (retained) */
export {
  getSeededPaperGrainGradientConfig,
  getSeededPaperMeshGradientConfig,
  paperGrainGradientDefaults,
  paperMeshGradientDefaults,
  resolvePaperGrainGradientConfig,
  resolvePaperMeshGradientConfig,
} from "../common/paper"
export type {
  PaperGrainGradientConfig,
  PaperMeshGradientConfig,
  SeededPaperOption,
} from "../common/paper"
export { PaperGrainGradient } from "./paper/grain-gradient"
export type { PaperGrainGradientProps } from "./paper/grain-gradient"
export { PaperMeshGradient } from "./paper/mesh-gradient"
export type { PaperMeshGradientProps } from "./paper/mesh-gradient"
