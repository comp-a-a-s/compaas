import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export interface FloatingSelectOption {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
  badge?: string;
  icon?: React.ReactNode;
  keywords?: string[];
}

export interface FloatingSelectProps {
  value: string;
  options: FloatingSelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  ariaLabel: string;
  searchable?: boolean;
  size?: 'sm' | 'md';
  variant?: 'pill' | 'input' | 'card';
  maxHeight?: number;
  className?: string;
  style?: React.CSSProperties;
  disabled?: boolean;
}

interface MenuPosition {
  top: number;
  left: number;
  width: number;
}

function normalizeText(input: string): string {
  return input.trim().toLowerCase();
}

export default function FloatingSelect({
  value,
  options,
  onChange,
  placeholder = 'Select option',
  ariaLabel,
  searchable = false,
  size = 'md',
  variant = 'input',
  maxHeight = 280,
  className,
  style,
  disabled = false,
}: FloatingSelectProps) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const typeBufferRef = useRef('');
  const typeResetTimerRef = useRef<number | null>(null);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null);

  const selectedOption = useMemo(
    () => options.find((opt) => opt.value === value),
    [options, value],
  );

  const filteredOptions = useMemo(() => {
    if (!searchable) return options;
    const q = normalizeText(query);
    if (!q) return options;
    return options.filter((opt) => {
      const haystack = [opt.label, opt.description || '', ...(opt.keywords || [])]
        .map((part) => normalizeText(part))
        .join(' ');
      return haystack.includes(q);
    });
  }, [options, query, searchable]);

  const enabledOptions = useMemo(
    () => filteredOptions.filter((opt) => !opt.disabled),
    [filteredOptions],
  );

  const updateMenuPosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    setMenuPosition({
      top: rect.bottom + 6,
      left: rect.left,
      width: rect.width,
    });
  }, []);

  const closeMenu = useCallback(() => {
    setOpen(false);
    setQuery('');
    setHighlightedIndex(-1);
  }, []);

  const openMenu = useCallback(() => {
    if (disabled) return;
    updateMenuPosition();
    setOpen(true);
  }, [disabled, updateMenuPosition]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (evt: PointerEvent) => {
      const target = evt.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      closeMenu();
    };
    const onKeyDown = (evt: KeyboardEvent) => {
      if (evt.key === 'Escape') {
        evt.preventDefault();
        closeMenu();
        triggerRef.current?.focus();
      }
    };
    const onReposition = () => updateMenuPosition();
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', onReposition);
    window.addEventListener('scroll', onReposition, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', onReposition);
      window.removeEventListener('scroll', onReposition, true);
    };
  }, [open, closeMenu, updateMenuPosition]);

  useEffect(() => {
    if (!open) return;
    updateMenuPosition();
    const initialIndex = filteredOptions.findIndex((opt) => !opt.disabled && opt.value === value);
    const fallbackIndex = filteredOptions.findIndex((opt) => !opt.disabled);
    const nextIndex = initialIndex >= 0 ? initialIndex : fallbackIndex;
    const frame = window.requestAnimationFrame(() => {
      setHighlightedIndex(nextIndex);
    });
    const focusTimer = window.setTimeout(() => {
      if (searchable) {
        searchRef.current?.focus();
      } else {
        menuRef.current?.focus();
      }
    }, 0);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(focusTimer);
    };
  }, [open, filteredOptions, searchable, updateMenuPosition, value]);

  useEffect(() => () => {
    if (typeResetTimerRef.current !== null) {
      window.clearTimeout(typeResetTimerRef.current);
    }
  }, []);

  const chooseOption = useCallback((opt: FloatingSelectOption) => {
    if (opt.disabled) return;
    onChange(opt.value);
    closeMenu();
  }, [onChange, closeMenu]);

  const stepHighlight = useCallback((delta: number) => {
    if (enabledOptions.length === 0) return;
    const currentValue = filteredOptions[highlightedIndex]?.value;
    const currentEnabledIndex = enabledOptions.findIndex((opt) => opt.value === currentValue);
    const base = currentEnabledIndex >= 0 ? currentEnabledIndex : 0;
    const nextEnabledIndex = (base + delta + enabledOptions.length) % enabledOptions.length;
    const nextValue = enabledOptions[nextEnabledIndex]?.value;
    const nextIndex = filteredOptions.findIndex((opt) => opt.value === nextValue);
    if (nextIndex >= 0) setHighlightedIndex(nextIndex);
  }, [enabledOptions, filteredOptions, highlightedIndex]);

  const handleTypeAhead = useCallback((key: string) => {
    const printable = key.length === 1 && /\S/.test(key);
    if (!printable || searchable) return;
    typeBufferRef.current = `${typeBufferRef.current}${key.toLowerCase()}`;
    if (typeResetTimerRef.current !== null) {
      window.clearTimeout(typeResetTimerRef.current);
    }
    typeResetTimerRef.current = window.setTimeout(() => {
      typeBufferRef.current = '';
      typeResetTimerRef.current = null;
    }, 500);
    const match = filteredOptions.find((opt) => {
      if (opt.disabled) return false;
      const text = normalizeText(opt.label);
      return text.startsWith(typeBufferRef.current);
    });
    if (!match) return;
    const matchIndex = filteredOptions.findIndex((opt) => opt.value === match.value);
    setHighlightedIndex(matchIndex);
  }, [filteredOptions, searchable]);

  const handleTriggerKeyDown = (evt: React.KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (!open && (evt.key === 'ArrowDown' || evt.key === 'ArrowUp' || evt.key === 'Enter' || evt.key === ' ')) {
      evt.preventDefault();
      openMenu();
      return;
    }
    if (open) {
      if (evt.key === 'ArrowDown') {
        evt.preventDefault();
        stepHighlight(1);
        return;
      }
      if (evt.key === 'ArrowUp') {
        evt.preventDefault();
        stepHighlight(-1);
        return;
      }
      if (evt.key === 'Enter') {
        evt.preventDefault();
        const opt = filteredOptions[highlightedIndex];
        if (opt && !opt.disabled) chooseOption(opt);
        return;
      }
      handleTypeAhead(evt.key);
    }
  };

  const handleMenuKeyDown = (evt: React.KeyboardEvent<HTMLDivElement>) => {
    if (evt.key === 'ArrowDown') {
      evt.preventDefault();
      stepHighlight(1);
      return;
    }
    if (evt.key === 'ArrowUp') {
      evt.preventDefault();
      stepHighlight(-1);
      return;
    }
    if (evt.key === 'Enter') {
      evt.preventDefault();
      const opt = filteredOptions[highlightedIndex];
      if (opt && !opt.disabled) chooseOption(opt);
      return;
    }
    if (evt.key === 'Escape') {
      evt.preventDefault();
      closeMenu();
      triggerRef.current?.focus();
      return;
    }
    handleTypeAhead(evt.key);
  };

  const triggerSizeClass = size === 'sm' ? 'floating-select-trigger-sm' : 'floating-select-trigger-md';
  const triggerVariantClass =
    variant === 'pill'
      ? 'floating-select-trigger-pill'
      : variant === 'card'
        ? 'floating-select-trigger-card'
        : 'floating-select-trigger-input';

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`floating-select-trigger ${triggerSizeClass} ${triggerVariantClass}${disabled ? ' floating-select-disabled' : ''}${className ? ` ${className}` : ''}`}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? closeMenu() : openMenu())}
        onKeyDown={handleTriggerKeyDown}
        style={style}
        disabled={disabled}
      >
        <span className="floating-select-trigger-content">
          {selectedOption?.icon && <span className="floating-select-trigger-icon">{selectedOption.icon}</span>}
          <span className="floating-select-trigger-label">
            {selectedOption?.label || placeholder}
          </span>
          {selectedOption?.badge && (
            <span className="floating-select-trigger-badge">{selectedOption.badge}</span>
          )}
        </span>
        <span className={`floating-select-caret${open ? ' floating-select-caret-open' : ''}`}>▾</span>
      </button>

      {open && menuPosition && createPortal(
        <div
          className="floating-select-menu"
          ref={menuRef}
          role="listbox"
          aria-label={ariaLabel}
          tabIndex={-1}
          onKeyDown={handleMenuKeyDown}
          style={{
            top: `${menuPosition.top}px`,
            left: `${menuPosition.left}px`,
            minWidth: `${menuPosition.width}px`,
            maxHeight: `${maxHeight}px`,
          }}
        >
          {searchable && (
            <div className="floating-select-search-wrap">
              <input
                ref={searchRef}
                value={query}
                onChange={(evt) => setQuery(evt.target.value)}
                placeholder="Search..."
                className="floating-select-search"
                aria-label={`${ariaLabel} search`}
              />
            </div>
          )}
          <div className="floating-select-options" style={{ maxHeight: `${maxHeight - (searchable ? 48 : 8)}px` }}>
            {filteredOptions.length === 0 ? (
              <div className="floating-select-empty">No results</div>
            ) : filteredOptions.map((opt, idx) => (
              <button
                type="button"
                key={opt.value}
                className={`floating-select-option${opt.disabled ? ' floating-select-option-disabled' : ''}${idx === highlightedIndex ? ' floating-select-option-highlighted' : ''}${opt.value === value ? ' floating-select-option-selected' : ''}`}
                role="option"
                aria-selected={opt.value === value}
                disabled={opt.disabled}
                onMouseEnter={() => setHighlightedIndex(idx)}
                onClick={() => chooseOption(opt)}
              >
                <div className="floating-select-option-main">
                  {opt.icon && <span className="floating-select-option-icon">{opt.icon}</span>}
                  <div className="floating-select-option-text">
                    <span className="floating-select-option-label">{opt.label}</span>
                    {opt.description && (
                      <span className="floating-select-option-description">{opt.description}</span>
                    )}
                  </div>
                </div>
                {opt.badge && <span className="floating-select-option-badge">{opt.badge}</span>}
              </button>
            ))}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
