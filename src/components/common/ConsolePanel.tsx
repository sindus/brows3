'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { Box, IconButton, Tooltip, Typography } from '@mui/material';
import {
  Close as CloseIcon,
  DeleteOutline as ClearIcon,
  ContentCopy as CopyIcon,
} from '@mui/icons-material';
import { useConsoleStore, ConsoleEntry } from '@/store/consoleStore';

const MIN_HEIGHT = 120;
const DEFAULT_HEIGHT = 220;
const MAX_HEIGHT = 600;

function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function StatusDot({ status }: { status: ConsoleEntry['status'] }) {
  const color =
    status === 'success' ? '#4caf50' :
    status === 'error'   ? '#f44336' :
    '#9e9e9e';
  return (
    <Box
      component="span"
      sx={{
        display: 'inline-block',
        width: 7,
        height: 7,
        borderRadius: '50%',
        bgcolor: color,
        flexShrink: 0,
        mt: '1px',
        ...(status === 'pending' && {
          animation: 'pulse 1.2s ease-in-out infinite',
          '@keyframes pulse': {
            '0%, 100%': { opacity: 1 },
            '50%': { opacity: 0.3 },
          },
        }),
      }}
    />
  );
}

export function ConsolePanel() {
  const entries = useConsoleStore((s) => s.entries);
  const setOpen = useConsoleStore((s) => s.setOpen);
  const clear = useConsoleStore((s) => s.clear);

  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const dragging = useRef(false);
  const dragStartY = useRef(0);
  const dragStartH = useRef(DEFAULT_HEIGHT);
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);

  // Auto-scroll to bottom when new entries arrive, if already at bottom
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (atBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [entries]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
  }, []);

  // Drag-to-resize logic
  const onDragStart = useCallback((e: React.MouseEvent) => {
    dragging.current = true;
    dragStartY.current = e.clientY;
    dragStartH.current = height;
    e.preventDefault();
  }, [height]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const delta = dragStartY.current - e.clientY;
      setHeight(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, dragStartH.current + delta)));
    };
    const onUp = () => { dragging.current = false; };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  const copyAll = useCallback(() => {
    const text = entries
      .map((e) => `[${formatTime(e.timestamp)}] ${e.command}${e.error ? ` # ERROR: ${e.error}` : ''}`)
      .join('\n');
    navigator.clipboard.writeText(text).catch(() => {});
  }, [entries]);

  return (
    <Box
      sx={{
        flexShrink: 0,
        height,
        display: 'flex',
        flexDirection: 'column',
        borderTop: '1px solid',
        borderColor: 'divider',
        bgcolor: '#0d1117',
        overflow: 'hidden',
      }}
    >
      {/* Drag handle */}
      <Box
        onMouseDown={onDragStart}
        sx={{
          height: 4,
          cursor: 'ns-resize',
          bgcolor: 'transparent',
          flexShrink: 0,
          '&:hover': { bgcolor: 'primary.main' },
          transition: 'background-color 0.15s',
        }}
      />

      {/* Header */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          px: 1.5,
          py: 0.5,
          borderBottom: '1px solid rgba(255,255,255,0.08)',
          flexShrink: 0,
          gap: 1,
        }}
      >
        <Typography
          variant="caption"
          sx={{ fontFamily: 'monospace', color: '#8b949e', fontWeight: 600, letterSpacing: 1, flex: 1 }}
        >
          CONSOLE
          <Box component="span" sx={{ ml: 1.5, color: '#555', fontWeight: 400 }}>
            {entries.length} command{entries.length !== 1 ? 's' : ''}
          </Box>
        </Typography>

        <Tooltip title="Copy all">
          <IconButton size="small" onClick={copyAll} sx={{ color: '#8b949e', p: 0.5, '&:hover': { color: '#e6edf3' } }}>
            <CopyIcon sx={{ fontSize: 14 }} />
          </IconButton>
        </Tooltip>
        <Tooltip title="Clear">
          <IconButton size="small" onClick={clear} sx={{ color: '#8b949e', p: 0.5, '&:hover': { color: '#e6edf3' } }}>
            <ClearIcon sx={{ fontSize: 14 }} />
          </IconButton>
        </Tooltip>
        <Tooltip title="Close console">
          <IconButton size="small" onClick={() => setOpen(false)} sx={{ color: '#8b949e', p: 0.5, '&:hover': { color: '#e6edf3' } }}>
            <CloseIcon sx={{ fontSize: 14 }} />
          </IconButton>
        </Tooltip>
      </Box>

      {/* Log entries */}
      <Box
        ref={scrollRef}
        onScroll={handleScroll}
        sx={{
          flex: 1,
          overflowY: 'auto',
          px: 1.5,
          py: 0.5,
          fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", monospace',
          fontSize: '0.72rem',
          lineHeight: 1.7,
          '&::-webkit-scrollbar': { width: 6 },
          '&::-webkit-scrollbar-track': { bgcolor: 'transparent' },
          '&::-webkit-scrollbar-thumb': { bgcolor: 'rgba(255,255,255,0.1)', borderRadius: 3 },
        }}
      >
        {entries.length === 0 ? (
          <Typography sx={{ color: '#555', fontFamily: 'monospace', fontSize: '0.72rem', mt: 1 }}>
            No commands yet. Perform any S3 action to see the equivalent AWS CLI commands.
          </Typography>
        ) : (
          entries.map((entry) => (
            <Box
              key={entry.id}
              sx={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 1,
                py: 0.1,
                '&:hover': { bgcolor: 'rgba(255,255,255,0.03)', borderRadius: 0.5 },
              }}
            >
              {/* Timestamp */}
              <Box component="span" sx={{ color: '#555', flexShrink: 0, userSelect: 'none' }}>
                {formatTime(entry.timestamp)}
              </Box>

              {/* Status dot */}
              <Box component="span" sx={{ display: 'flex', alignItems: 'center', pt: 0.4, flexShrink: 0 }}>
                <StatusDot status={entry.status} />
              </Box>

              {/* Command */}
              <Box component="span" sx={{ color: entry.status === 'error' ? '#f85149' : '#e6edf3', wordBreak: 'break-all' }}>
                {entry.command}
                {entry.durationMs !== undefined && (
                  <Box component="span" sx={{ color: '#555', ml: 1 }}>
                    ({entry.durationMs}ms)
                  </Box>
                )}
                {entry.error && (
                  <Box component="span" sx={{ color: '#f85149', display: 'block', pl: 2 }}>
                    # {entry.error}
                  </Box>
                )}
              </Box>
            </Box>
          ))
        )}
      </Box>
    </Box>
  );
}
