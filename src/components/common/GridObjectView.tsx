'use client';

import { forwardRef, memo, useMemo, useCallback, useEffect, useRef, useState } from 'react';
import {
  Box,
  Typography,
  IconButton,
  CircularProgress,
  Stack,
  Divider,
} from '@mui/material';
import {
  Folder as FolderIcon,
  Image as ImageIcon,
  VideoFile as VideoIcon,
  AudioFile as AudioIcon,
  PictureAsPdf as PdfIcon,
  Code as CodeIcon,
  DataObject as JsonIcon,
  TextSnippet as TextIcon,
  InsertDriveFile as FileIcon,
  Archive as ArchiveIcon,
  MoreVert as MoreVertIcon,
} from '@mui/icons-material';
import { VirtuosoGrid, type GridComponents, type GridListProps, type ListRange } from 'react-virtuoso';
import { S3Object } from '@/lib/tauri';
import { formatSize, getFileExtension } from '@/lib/utils';
import { getThumbnailKind, THUMBNAIL_IMAGE_EXTENSIONS, THUMBNAIL_VIDEO_EXTENSIONS } from '@/lib/mediaTypes';
import { useThumbnails } from '@/hooks/useThumbnails';
import { StyledCheckbox } from './StyledCheckbox';

const CARD_WIDTH = 140;
const CARD_HEIGHT = 150;
const THUMB_SIZE = 80;
const GAP = 12;
/** Thumbnails are also requested for this many items around the visible range. */
const PREFETCH_ITEMS = 24;
const PREVIEW_HOVER_DELAY_MS = 300;

const ICON_SX = { fontSize: THUMB_SIZE * 0.55 };

const IMAGE_ICON = <ImageIcon sx={{ ...ICON_SX, color: '#4CAF50' }} />;
const VIDEO_ICON = <VideoIcon sx={{ ...ICON_SX, color: '#9C27B0' }} />;

const ICON_MAP: Record<string, React.ReactNode> = {
  ...Object.fromEntries([...THUMBNAIL_IMAGE_EXTENSIONS, 'svg'].map((ext) => [ext, IMAGE_ICON])),
  ...Object.fromEntries([...THUMBNAIL_VIDEO_EXTENSIONS].map((ext) => [ext, VIDEO_ICON])),
  mp3:  <AudioIcon sx={{ ...ICON_SX, color: '#FF5722' }} />,
  wav:  <AudioIcon sx={{ ...ICON_SX, color: '#FF5722' }} />,
  ogg:  <AudioIcon sx={{ ...ICON_SX, color: '#FF5722' }} />,
  flac: <AudioIcon sx={{ ...ICON_SX, color: '#FF5722' }} />,
  aac:  <AudioIcon sx={{ ...ICON_SX, color: '#FF5722' }} />,
  pdf:  <PdfIcon   sx={{ ...ICON_SX, color: '#F44336' }} />,
  json: <JsonIcon  sx={{ ...ICON_SX, color: '#FFC107' }} />,
  js:   <CodeIcon  sx={{ ...ICON_SX, color: '#2196F3' }} />,
  ts:   <CodeIcon  sx={{ ...ICON_SX, color: '#2196F3' }} />,
  jsx:  <CodeIcon  sx={{ ...ICON_SX, color: '#2196F3' }} />,
  tsx:  <CodeIcon  sx={{ ...ICON_SX, color: '#2196F3' }} />,
  py:   <CodeIcon  sx={{ ...ICON_SX, color: '#2196F3' }} />,
  go:   <CodeIcon  sx={{ ...ICON_SX, color: '#2196F3' }} />,
  rs:   <CodeIcon  sx={{ ...ICON_SX, color: '#2196F3' }} />,
  txt:  <TextIcon  sx={{ ...ICON_SX, color: '#607D8B' }} />,
  md:   <TextIcon  sx={{ ...ICON_SX, color: '#607D8B' }} />,
  csv:  <TextIcon  sx={{ ...ICON_SX, color: '#607D8B' }} />,
  zip:  <ArchiveIcon sx={{ ...ICON_SX, color: '#795548' }} />,
  tar:  <ArchiveIcon sx={{ ...ICON_SX, color: '#795548' }} />,
  gz:   <ArchiveIcon sx={{ ...ICON_SX, color: '#795548' }} />,
  rar:  <ArchiveIcon sx={{ ...ICON_SX, color: '#795548' }} />,
};

const FOLDER_ICON_EL = <FolderIcon sx={{ fontSize: THUMB_SIZE * 0.65, color: '#FFB74D' }} />;
const DEFAULT_FILE_ICON = <FileIcon sx={{ ...ICON_SX, color: '#9E9E9E' }} />;

const getIcon = (name: string, isFolder: boolean): React.ReactNode => {
  if (isFolder) return FOLDER_ICON_EL;
  return ICON_MAP[getFileExtension(name)] ?? DEFAULT_FILE_ICON;
};

interface GridItem {
  key: string;
  name: string;
  isFolder: boolean;
  size: number;
  object?: S3Object;
}

interface Props {
  folders: string[];
  objects: S3Object[];
  selectedKeys: Set<string>;
  isLoading: boolean;
  onNavigate: (prefix: string) => void;
  onSelect: (key: string, checked: boolean) => void;
  onMenuOpen: (event: React.MouseEvent<HTMLElement>, key: string, isFolder: boolean) => void;
  onPreview?: (key: string, size: number) => void;
  onEndReached?: () => void;
  /** Thumbnails are only generated when a bucket is given. */
  bucketName?: string;
  bucketRegion?: string;
  /** Identity of the folder view (profile, bucket, prefix): thumbnails reset when it changes. */
  scopeKey?: string;
}

interface CardActions {
  open: (item: GridItem) => void;
  select: (key: string, checked: boolean) => void;
  menu: (event: React.MouseEvent<HTMLElement>, key: string, isFolder: boolean) => void;
  wantPreview: (object: S3Object) => void;
}

const GridCard = memo(function GridCard({
  item,
  isSelected,
  thumbnail,
  preview,
  previewLoading,
  actions,
}: {
  item: GridItem;
  isSelected: boolean;
  thumbnail?: string;
  preview?: string;
  previewLoading: boolean;
  actions: CardActions;
}) {
  const [hovered, setHovered] = useState(false);
  const isVideo = !item.isFolder && getThumbnailKind(item.key) === 'video';

  // Build the animated preview only for videos the user lingers on.
  useEffect(() => {
    if (!hovered || !isVideo || !thumbnail || preview || !item.object) return;
    const object = item.object;
    const timer = setTimeout(() => actions.wantPreview(object), PREVIEW_HOVER_DELAY_MS);
    return () => clearTimeout(timer);
  }, [hovered, isVideo, thumbnail, preview, item.object, actions]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      actions.open(item);
    } else if (event.key === ' ') {
      event.preventDefault();
      actions.select(item.key, !isSelected);
    }
  };

  const image = hovered && preview ? preview : thumbnail;

  return (
    <Box
      role="group"
      tabIndex={0}
      aria-label={item.name}
      onKeyDown={handleKeyDown}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      sx={{
        width: CARD_WIDTH,
        height: CARD_HEIGHT,
        borderRadius: 2,
        border: '1px solid',
        borderColor: isSelected ? 'primary.main' : 'divider',
        bgcolor: isSelected ? 'action.selected' : 'background.paper',
        overflow: 'hidden',
        cursor: 'pointer',
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        transition: 'border-color 0.15s, box-shadow 0.15s',
        outline: 'none',
        '&:hover, &:focus-visible': {
          borderColor: 'primary.light',
          boxShadow: '0 2px 8px rgba(0,0,0,0.12)',
        },
        '&:focus-visible': { borderColor: 'primary.main' },
        '&:hover .card-overlay, &:focus-within .card-overlay': { opacity: 1 },
      }}
      onClick={() => actions.open(item)}
    >
      {/* Thumbnail / Icon area */}
      <Box
        sx={{
          position: 'relative',
          flex: 1,
          minHeight: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          bgcolor: '#000',
          overflow: 'hidden',
        }}
      >
        {image ? (
          <Box
            component="img"
            src={image}
            alt={item.name}
            loading="lazy"
            decoding="async"
            draggable={false}
            sx={{ width: '100%', height: '100%', objectFit: 'contain' }}
          />
        ) : (
          getIcon(item.name, item.isFolder)
        )}
        {hovered && previewLoading && !preview && (
          <Box
            sx={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              bgcolor: 'rgba(0, 0, 0, 0.45)',
              pointerEvents: 'none',
            }}
          >
            <CircularProgress
              size={28}
              thickness={5}
              aria-label={`Loading preview of ${item.name}`}
              sx={{ color: 'common.white' }}
            />
          </Box>
        )}
      </Box>

      {/* Name + size area */}
      <Box
        sx={{
          px: 1,
          py: 0.75,
          borderTop: '1px solid',
          borderColor: 'divider',
          bgcolor: 'background.paper',
        }}
      >
        <Typography
          variant="caption"
          display="block"
          noWrap
          title={item.name}
          sx={{ fontWeight: item.isFolder ? 600 : 400, lineHeight: 1.3 }}
        >
          {item.name}
        </Typography>
        {!item.isFolder && (
          <Typography variant="caption" display="block" sx={{ color: 'text.secondary', fontSize: '0.65rem' }}>
            {formatSize(item.size)}
          </Typography>
        )}
      </Box>

      {/* Hover overlay: checkbox top-left, menu top-right */}
      <Box
        className="card-overlay"
        sx={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          opacity: isSelected ? 1 : 0,
          transition: 'opacity 0.15s',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          p: 0.25,
          pointerEvents: 'none',
        }}
      >
        <Box
          sx={{ pointerEvents: 'auto' }}
          onClick={(e) => { e.stopPropagation(); actions.select(item.key, !isSelected); }}
        >
          <Box sx={{ p: 0.25 }}>
            <StyledCheckbox
              aria-label={`Select ${item.key}`}
              checked={isSelected}
              onChange={(e) => { e.stopPropagation(); actions.select(item.key, e.target.checked); }}
            />
          </Box>
        </Box>
        <Box
          sx={{ pointerEvents: 'auto' }}
          onClick={(e) => { e.stopPropagation(); actions.menu(e, item.key, item.isFolder); }}
        >
          <IconButton
            size="small"
            aria-label={`Actions for ${item.name}`}
            sx={{ p: 0.25, bgcolor: 'background.paper', opacity: 0.85 }}
          >
            <MoreVertIcon sx={{ fontSize: 14 }} />
          </IconButton>
        </Box>
      </Box>
    </Box>
  );
});

const GridList: GridComponents['List'] = forwardRef<HTMLDivElement, GridListProps>(function GridList(
  { style, children, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      {...props}
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(auto-fill, minmax(${CARD_WIDTH}px, 1fr))`,
        gap: GAP,
        paddingLeft: GAP,
        paddingRight: GAP,
        // Virtuoso sets the vertical padding that stands for off-screen rows.
        ...style,
      }}
    >
      {children}
    </div>
  );
});

const GRID_COMPONENTS: GridComponents = { List: GridList };

export const GridObjectView = memo(function GridObjectView({
  folders = [],
  objects = [],
  selectedKeys,
  isLoading,
  onNavigate,
  onSelect,
  onMenuOpen,
  onPreview,
  onEndReached,
  bucketName,
  bucketRegion,
  scopeKey = '',
}: Props) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  const { thumbnails, previews, loadingPreviews, requestThumbnails, requestPreview } = useThumbnails(
    bucketName ?? '',
    bucketRegion,
    scopeKey,
  );

  // The page recreates its handlers on every render. Cards get stable actions
  // that call the latest handlers, so a thumbnail only re-renders its own card.
  const handlers = useRef({ onNavigate, onSelect, onMenuOpen, onPreview, requestPreview });
  useEffect(() => {
    handlers.current = { onNavigate, onSelect, onMenuOpen, onPreview, requestPreview };
  });
  const actions = useMemo<CardActions>(() => ({
    open: (item) => {
      if (item.isFolder) handlers.current.onNavigate(item.key);
      else handlers.current.onPreview?.(item.key, item.size);
    },
    select: (key, checked) => handlers.current.onSelect(key, checked),
    menu: (event, key, isFolder) => handlers.current.onMenuOpen(event, key, isFolder),
    wantPreview: (object) => handlers.current.requestPreview(object),
  }), []);

  const items = useMemo<GridItem[]>(() => {
    const result: GridItem[] = [];
    for (const prefix of folders) {
      const parts = prefix.split('/').filter(Boolean);
      result.push({ key: prefix, name: parts[parts.length - 1] || prefix, isFolder: true, size: 0 });
    }
    for (const obj of objects) {
      const parts = obj.key.split('/');
      result.push({ key: obj.key, name: parts[parts.length - 1] || obj.key, isFolder: false, size: obj.size, object: obj });
    }
    return result;
  }, [folders, objects]);

  const setScrollRef = useCallback((element: HTMLDivElement | null) => {
    scrollRef.current = element;
    setScrollElement(element);
  }, []);

  // Request thumbnails for what is on screen, plus a margin.
  const lastRange = useRef<ListRange | null>(null);
  const handleRangeChanged = useCallback((range: ListRange) => {
    lastRange.current = range;
    if (!bucketName) return;
    const start = Math.max(0, range.startIndex - PREFETCH_ITEMS);
    const end = Math.min(items.length, range.endIndex + PREFETCH_ITEMS + 1);
    const visible: S3Object[] = [];
    for (let index = start; index < end; index += 1) {
      const object = items[index]?.object;
      if (object) visible.push(object);
    }
    requestThumbnails(visible);
  }, [bucketName, items, requestThumbnails]);

  // New items (next page, search results) may already be on screen.
  useEffect(() => {
    if (lastRange.current) handleRangeChanged(lastRange.current);
  }, [handleRangeChanged]);

  // Ask for the next page while the end-of-grid sentinel is (nearly) visible.
  // Observing again after every change re-checks it, so a short first page
  // keeps loading until the grid fills the view or no pages remain.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!onEndReached || !sentinel) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) onEndReached();
      },
      { root: scrollRef.current, rootMargin: '300px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [onEndReached, items.length, isLoading]);

  return (
    <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', border: 1, borderColor: 'divider', borderRadius: 1, overflow: 'hidden' }}>
      <Box ref={setScrollRef} sx={{ flex: 1, overflow: 'auto' }}>
        {isLoading ? (
          <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: 200, gap: 2 }}>
            <CircularProgress size={32} />
            <Typography variant="caption" color="text.secondary">Loading...</Typography>
          </Box>
        ) : items.length === 0 ? (
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 200 }}>
            <Typography color="text.secondary">Empty folder</Typography>
          </Box>
        ) : (
          <>
            <Box sx={{ height: GAP }} />
            {scrollElement && (
              <VirtuosoGrid
                customScrollParent={scrollElement}
                totalCount={items.length}
                components={GRID_COMPONENTS}
                computeItemKey={(index) => items[index]?.key ?? index}
                increaseViewportBy={CARD_HEIGHT * 2}
                rangeChanged={handleRangeChanged}
                itemContent={(index) => {
                  const item = items[index];
                  if (!item) return null;
                  return (
                    <GridCard
                      item={item}
                      isSelected={selectedKeys.has(item.key)}
                      thumbnail={thumbnails.get(item.key)}
                      preview={previews.get(item.key)}
                      previewLoading={loadingPreviews.has(item.key)}
                      actions={actions}
                    />
                  );
                }}
              />
            )}
            <Box sx={{ height: GAP }} />
            <Box ref={sentinelRef} aria-hidden sx={{ height: 1 }} />
          </>
        )}
      </Box>

      {/* Footer — same pattern as list view */}
      <Box sx={{
        px: 2,
        py: 0.75,
        borderTop: 1,
        borderColor: 'divider',
        bgcolor: 'background.paper',
        display: 'flex',
        alignItems: 'center',
        minHeight: 32,
      }}>
        <Stack direction="row" spacing={3} alignItems="center">
          <Typography variant="caption">
            <Box component="span" fontWeight={700} color="text.primary">{items.length.toLocaleString()}</Box>
            {' '}
            <Box component="span" color="text.secondary">items</Box>
          </Typography>
          <Divider orientation="vertical" flexItem sx={{ height: 12, my: 'auto' }} />
          <Stack direction="row" spacing={1.5}>
            <Typography variant="caption">
              <Box component="span" fontWeight={600} color="text.secondary">{folders.length.toLocaleString()}</Box>
              {' '}
              <Box component="span" color="text.secondary">folders</Box>
            </Typography>
            <Typography variant="caption">
              <Box component="span" fontWeight={600} color="text.secondary">{objects.length.toLocaleString()}</Box>
              {' '}
              <Box component="span" color="text.secondary">files</Box>
            </Typography>
          </Stack>
        </Stack>
      </Box>
    </Box>
  );
});
