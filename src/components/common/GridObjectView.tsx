'use client';

import { memo, useMemo, useCallback } from 'react';
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
import { S3Object } from '@/lib/tauri';
import { formatSize } from '@/lib/utils';
import { StyledCheckbox } from './StyledCheckbox';

const CARD_WIDTH = 140;
const CARD_HEIGHT = 150;
const THUMB_SIZE = 80;

const getExt = (name: string): string => {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
};

const ICON_SX = { fontSize: THUMB_SIZE * 0.55 };

const ICON_MAP: Record<string, React.ReactNode> = {
  jpg:  <ImageIcon sx={{ ...ICON_SX, color: '#4CAF50' }} />,
  jpeg: <ImageIcon sx={{ ...ICON_SX, color: '#4CAF50' }} />,
  png:  <ImageIcon sx={{ ...ICON_SX, color: '#4CAF50' }} />,
  gif:  <ImageIcon sx={{ ...ICON_SX, color: '#4CAF50' }} />,
  webp: <ImageIcon sx={{ ...ICON_SX, color: '#4CAF50' }} />,
  svg:  <ImageIcon sx={{ ...ICON_SX, color: '#4CAF50' }} />,
  ico:  <ImageIcon sx={{ ...ICON_SX, color: '#4CAF50' }} />,
  bmp:  <ImageIcon sx={{ ...ICON_SX, color: '#4CAF50' }} />,
  tiff: <ImageIcon sx={{ ...ICON_SX, color: '#4CAF50' }} />,
  mp4:  <VideoIcon sx={{ ...ICON_SX, color: '#9C27B0' }} />,
  webm: <VideoIcon sx={{ ...ICON_SX, color: '#9C27B0' }} />,
  mov:  <VideoIcon sx={{ ...ICON_SX, color: '#9C27B0' }} />,
  avi:  <VideoIcon sx={{ ...ICON_SX, color: '#9C27B0' }} />,
  mkv:  <VideoIcon sx={{ ...ICON_SX, color: '#9C27B0' }} />,
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
  return ICON_MAP[getExt(name)] ?? DEFAULT_FILE_ICON;
};

interface GridItem {
  key: string;
  name: string;
  isFolder: boolean;
  size: number;
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
  /** base64 data URLs keyed by S3 object key — populated progressively in step 5 */
  thumbnails?: Map<string, string>;
}

const GridCard = memo(function GridCard({
  item,
  isSelected,
  thumbnail,
  onSelect,
  onNavigate,
  onMenuOpen,
  onPreview,
}: {
  item: GridItem;
  isSelected: boolean;
  thumbnail?: string;
  onSelect: (key: string, checked: boolean) => void;
  onNavigate: (prefix: string) => void;
  onMenuOpen: (event: React.MouseEvent<HTMLElement>, key: string, isFolder: boolean) => void;
  onPreview?: (key: string, size: number) => void;
}) {
  const handleClick = useCallback(() => {
    if (item.isFolder) {
      onNavigate(item.key);
    } else if (onPreview) {
      onPreview(item.key, item.size);
    }
  }, [item, onNavigate, onPreview]);

  return (
    <Box
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
        '&:hover': {
          borderColor: 'primary.light',
          boxShadow: '0 2px 8px rgba(0,0,0,0.12)',
          '& .card-overlay': { opacity: 1 },
        },
      }}
      onClick={handleClick}
    >
      {/* Thumbnail / Icon area */}
      <Box
        sx={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          bgcolor: 'action.hover',
          overflow: 'hidden',
        }}
      >
        {thumbnail ? (
          <Box
            component="img"
            src={thumbnail}
            alt={item.name}
            sx={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
            }}
          />
        ) : (
          getIcon(item.name, item.isFolder)
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
          onClick={(e) => { e.stopPropagation(); onSelect(item.key, !isSelected); }}
        >
          <Box sx={{ p: 0.25 }}>
            <StyledCheckbox
              checked={isSelected}
              onChange={(e) => { e.stopPropagation(); onSelect(item.key, e.target.checked); }}
            />
          </Box>
        </Box>
        <Box
          sx={{ pointerEvents: 'auto' }}
          onClick={(e) => { e.stopPropagation(); onMenuOpen(e, item.key, item.isFolder); }}
        >
          <IconButton size="small" sx={{ p: 0.25, bgcolor: 'background.paper', opacity: 0.85 }}>
            <MoreVertIcon sx={{ fontSize: 14 }} />
          </IconButton>
        </Box>
      </Box>
    </Box>
  );
});

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
  thumbnails,
}: Props) {
  const items = useMemo<GridItem[]>(() => {
    const result: GridItem[] = [];
    for (const prefix of folders) {
      const parts = prefix.split('/').filter(Boolean);
      result.push({ key: prefix, name: parts[parts.length - 1] || prefix, isFolder: true, size: 0 });
    }
    for (const obj of objects) {
      const parts = obj.key.split('/');
      result.push({ key: obj.key, name: parts[parts.length - 1] || obj.key, isFolder: false, size: obj.size });
    }
    return result;
  }, [folders, objects]);

  return (
    <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', border: 1, borderColor: 'divider', borderRadius: 1, overflow: 'hidden' }}>
      <Box sx={{ flex: 1, overflow: 'auto' }}>
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
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: `repeat(auto-fill, minmax(${CARD_WIDTH}px, 1fr))`,
              gap: 1.5,
              p: 1.5,
            }}
          >
            {items.map((item) => (
              <GridCard
                key={item.key}
                item={item}
                isSelected={selectedKeys.has(item.key)}
                thumbnail={thumbnails?.get(item.key)}
                onSelect={onSelect}
                onNavigate={onNavigate}
                onMenuOpen={onMenuOpen}
                onPreview={onPreview}
              />
            ))}
          </Box>
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
