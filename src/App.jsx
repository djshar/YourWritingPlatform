import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { HashRouter as Router, Routes, Route, Link, Navigate, useNavigate } from 'react-router-dom';
import { supabase } from './lib/supabase';
import './App.css';

const STORAGE_KEY = 'writing-platform-workspace';

function createBook(id, title) {
  return {
    id,
    title,
    chapters: [{ id: `${id}-chapter-1`, title: 'Chapter 1', content: '' }],
    activeChapterId: `${id}-chapter-1`,
    editorFont: 'serif',
    editorFontSize: 16,
    spellCheck: true,
    isManuscript: false,
    characters: [],
    world: [],
    notes: [],
    scenes: [],
  };
}

const initialBook = createBook('book-1', 'Untitled project');
const initialWorkspace = {
  books: [initialBook],
  activeBookId: initialBook.id,
  theme: 'sepia',
};

function normalizeBook(book, index) {
  const fallback = createBook(`book-${index + 1}`, `Untitled book ${index + 1}`);
  const normalized = { ...fallback, ...book };
  const recommendedFontSizes = [13.333333, 14, 14.666667, 15.333333, 16];
  const savedFontSize = Number(normalized.editorFontSize);
  const normalizedFontSize = Number.isFinite(savedFontSize) ? savedFontSize : 16;
  normalized.editorFontSize = recommendedFontSizes.reduce((closest, size) => (
    Math.abs(size - normalizedFontSize) < Math.abs(closest - normalizedFontSize) ? size : closest
  ), recommendedFontSizes[0]);
  normalized.chapters = Array.isArray(book.chapters) ? book.chapters : fallback.chapters;
  normalized.activeChapterId = normalized.chapters.some((chapter) => chapter.id === book.activeChapterId)
    ? book.activeChapterId
    : normalized.chapters[0]?.id ?? null;
  normalized.characters = Array.isArray(book.characters) ? book.characters : [];
  normalized.world = Array.isArray(book.world) ? book.world : [];
  normalized.notes = Array.isArray(book.notes) ? book.notes : [];
  normalized.scenes = Array.isArray(book.scenes) ? book.scenes : [];
  normalized.spellCheck = book.spellCheck !== false;
  return normalized;
}

function migrateWorkspace(saved) {
  if (Array.isArray(saved.books) && saved.books.length > 0) {
    const books = saved.books.map(normalizeBook);
    return {
      books,
      activeBookId: books.some((book) => book.id === saved.activeBookId) ? saved.activeBookId : books[0].id,
      theme: ['light', 'dark', 'sepia'].includes(saved.theme) ? saved.theme : 'sepia',
    };
  }

  const legacyBook = {
    ...saved,
    id: 'book-1',
    title: saved.title ?? 'Untitled project',
  };
  const book = normalizeBook(legacyBook, 0);
  return { books: [book], activeBookId: book.id, theme: 'sepia' };
}

const planningTabs = [
  { id: 'write', label: 'Write', icon: '✍' },
  { id: 'characters', label: 'Characters', icon: '♙' },
  { id: 'world', label: 'World', icon: '◎' },
  { id: 'notes', label: 'Notes', icon: '▤' },
  { id: 'storyboard', label: 'Storyboard', icon: '▦' },
];

const collections = {
  characters: {
    key: 'characters',
    eyebrow: 'Cast & character arcs',
    title: 'Character outlines',
    description: 'Build characters with a clear point of view, motivation, and room to change.',
    addLabel: 'Add character',
    itemLabel: 'Character',
    fields: [
      { name: 'name', label: 'Name', placeholder: 'Character name' },
      { name: 'role', label: 'Story role', placeholder: 'Protagonist, mentor, rival…' },
      { name: 'want', label: 'What they want', placeholder: 'Their external goal' },
      { name: 'need', label: 'What they need', placeholder: 'The truth they must face' },
      { name: 'flaw', label: 'Strength & flaw', placeholder: 'What helps and holds them back' },
      { name: 'arc', label: 'Character arc', placeholder: 'How they change by the end', multiline: true },
    ],
  },
  world: {
    key: 'world',
    eyebrow: 'Setting & story bible',
    title: 'World building',
    description: 'Keep the places, people, and rules of your story consistent as it grows.',
    addLabel: 'Add world detail',
    itemLabel: 'World detail',
    fields: [
      { name: 'name', label: 'Name', placeholder: 'A place, group, custom, or idea' },
      {
        name: 'kind',
        label: 'Type',
        placeholder: 'Choose a type',
        options: ['Location', 'Culture', 'History', 'Magic or technology', 'Other'],
      },
      { name: 'details', label: 'Details', placeholder: 'What should you remember about it?', multiline: true },
      { name: 'rules', label: 'Rules & story impact', placeholder: 'What can or cannot happen here?', multiline: true },
    ],
  },
  notes: {
    key: 'notes',
    eyebrow: 'Loose ideas & research',
    title: 'Notes',
    description: 'Catch stray ideas, research, and questions before they disappear.',
    addLabel: 'Add note',
    itemLabel: 'Note',
    fields: [
      { name: 'title', label: 'Title', placeholder: 'A thought to come back to' },
      {
        name: 'kind',
        label: 'Category',
        placeholder: 'Choose a category',
        options: ['Idea', 'Research', 'Question', 'Continuity', 'Other'],
      },
      { name: 'body', label: 'Note', placeholder: 'Write freely…', multiline: true },
    ],
  },
  scenes: {
    key: 'scenes',
    eyebrow: 'Plot & scene planning',
    title: 'Storyboard',
    description: 'Map the story beat by beat. Reorder scenes as your plot takes shape.',
    addLabel: 'Add scene',
    itemLabel: 'Scene',
    fields: [
      { name: 'title', label: 'Scene title', placeholder: 'A short working title' },
      {
        name: 'act',
        label: 'Act',
        placeholder: 'Choose an act',
        options: ['Act I · Setup', 'Act II · Confrontation', 'Act III · Resolution'],
      },
      { name: 'pov', label: 'POV character', placeholder: 'Who experiences this scene?' },
      { name: 'goal', label: 'Goal', placeholder: 'What does the character want here?' },
      { name: 'conflict', label: 'Conflict & turn', placeholder: 'What gets in the way? What changes?', multiline: true },
      { name: 'outcome', label: 'Outcome', placeholder: 'What pulls the reader into the next scene?', multiline: true },
    ],
  },
};

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function manuscriptFilename(title) {
  const invalidCharacters = '<>:"/\\|?*';
  const safeTitle = [...title.trim()]
    .filter((character) => character.charCodeAt(0) >= 32 && !invalidCharacters.includes(character))
    .join('')
    .replace(/\s+/g, ' ');
  return safeTitle || 'manuscript';
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function plainTextToEditorHtml(text = '') {
  return text.split(/\r?\n/).map((line) => `<p>${line ? escapeHtml(line) : '<br>'}</p>`).join('');
}

function sanitizeEditorHtml(html) {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const allowedTags = new Set(['P', 'DIV', 'BR', 'STRONG', 'B', 'EM', 'I', 'U', 'S', 'SPAN']);
  [...parsed.body.querySelectorAll('*')].reverse().forEach((element) => {
    if (!allowedTags.has(element.tagName)) {
      element.replaceWith(parsed.createTextNode(element.textContent ?? ''));
      return;
    }

    if (element.tagName === 'DIV') {
      const paragraph = parsed.createElement('p');
      const alignment = element.style.textAlign;
      const lineHeight = element.style.lineHeight;
      const textIndent = element.style.textIndent;
      while (element.firstChild) paragraph.append(element.firstChild);
      if (['left', 'center', 'right', 'justify'].includes(alignment)) paragraph.style.textAlign = alignment;
      if (['1', '1.15', '1.5', '2'].includes(lineHeight)) paragraph.style.lineHeight = lineHeight;
      if (/^(?:[0-7](?:\.\d+)?|8(?:\.0+)?)em$/.test(textIndent)) paragraph.style.textIndent = textIndent;
      element.replaceWith(paragraph);
      return;
    }

    const alignment = element.tagName === 'P' ? element.style.textAlign : '';
    const lineHeight = element.tagName === 'P' ? element.style.lineHeight : '';
    const textIndent = element.tagName === 'P' ? element.style.textIndent : '';
    [...element.attributes].forEach((attribute) => element.removeAttribute(attribute.name));
    if (['left', 'center', 'right', 'justify'].includes(alignment)) element.style.textAlign = alignment;
    if (['1', '1.15', '1.5', '2'].includes(lineHeight)) element.style.lineHeight = lineHeight;
    if (/^(?:[0-7](?:\.\d+)?|8(?:\.0+)?)em$/.test(textIndent)) element.style.textIndent = textIndent;
  });

  [...parsed.body.childNodes].forEach((node) => {
    if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) {
      const paragraph = parsed.createElement('p');
      paragraph.textContent = node.textContent;
      node.replaceWith(paragraph);
    }
  });

  return parsed.body.innerHTML || '<p><br></p>';
}

function textFromEditorNode(node) {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  if (node.tagName === 'BR') return '\n';
  return [...node.childNodes].map(textFromEditorNode).join('');
}

function editorHtmlToPlainText(html) {
  const parsed = new DOMParser().parseFromString(sanitizeEditorHtml(html), 'text/html');
  return [...parsed.body.children].map((paragraph) => {
    if (paragraph.tagName === 'P' && paragraph.childElementCount === 1 && paragraph.firstElementChild.tagName === 'BR') return '';
    return textFromEditorNode(paragraph);
  }).join('\n');
}

function getChapterParagraphs(chapter) {
  const html = chapter.contentHtml
    ? sanitizeEditorHtml(chapter.contentHtml)
    : plainTextToEditorHtml(chapter.content ?? '');
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  return [...parsed.body.children].map((paragraph) => ({
    text: textFromEditorNode(paragraph),
    alignment: ['left', 'center', 'right', 'justify'].includes(paragraph.style.textAlign)
      ? paragraph.style.textAlign
      : 'left',
    lineSpacing: ['1', '1.15', '1.5', '2'].includes(paragraph.style.lineHeight)
      ? paragraph.style.lineHeight
      : '1.5',
    indent: Math.min(8, Math.max(0, Number.parseFloat(paragraph.style.textIndent) || 0)),
  }));
}

function getTextOffsets(root, range) {
  const prefix = range.cloneRange();
  prefix.selectNodeContents(root);
  prefix.setEnd(range.startContainer, range.startOffset);
  return { start: prefix.toString().length, end: prefix.toString().length + range.toString().length };
}

function createRangeAtTextOffsets(root, startOffset, endOffset) {
  const textNodes = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) textNodes.push(walker.currentNode);

  let position = 0;
  let startPoint = null;
  let endPoint = null;
  textNodes.forEach((node) => {
    const nextPosition = position + (node.textContent?.length ?? 0);
    if (!startPoint && startOffset <= nextPosition) {
      startPoint = { node, offset: Math.max(0, startOffset - position) };
    }
    if (!endPoint && endOffset <= nextPosition) {
      endPoint = { node, offset: Math.max(0, endOffset - position) };
    }
    position = nextPosition;
  });

  if (!textNodes.length) return null;
  const range = document.createRange();
  const start = startPoint ?? { node: textNodes.at(-1), offset: textNodes.at(-1).textContent.length };
  const end = endPoint ?? { node: textNodes.at(-1), offset: textNodes.at(-1).textContent.length };
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  return range;
}

async function exportManuscript(book, format) {
  const filename = manuscriptFilename(book.title);
  const chapters = book.chapters.map((chapter, index) => ({
    source: chapter,
    title: chapter.title?.trim() || `Chapter ${index + 1}`,
    content: chapter.content ?? '',
  }));

  if (format === 'txt') {
    const text = [book.title, ...chapters.flatMap((chapter) => [chapter.title, chapter.content])].join('\n\n');
    downloadBlob(new Blob([text], { type: 'text/plain;charset=utf-8' }), `${filename}.txt`);
    return;
  }

  if (format === 'docx') {
    const { AlignmentType, Document, HeadingLevel, Packer, Paragraph, TextRun } = await import('docx');
    const font = book.editorFont === 'monospace'
      ? 'Courier New'
      : book.editorFont === 'sans-serif'
        ? 'Arial'
        : 'Georgia';
    const children = [new Paragraph({ text: book.title, heading: HeadingLevel.TITLE })];
    chapters.forEach((chapter) => {
      children.push(new Paragraph({ text: chapter.title, heading: HeadingLevel.HEADING_1 }));
      getChapterParagraphs(chapter.source).forEach((paragraph) => children.push(new Paragraph({
        alignment: {
          left: AlignmentType.LEFT,
          center: AlignmentType.CENTER,
          right: AlignmentType.RIGHT,
          justify: AlignmentType.JUSTIFIED,
        }[paragraph.alignment] ?? AlignmentType.LEFT,
        children: [new TextRun({ text: paragraph.text, font, size: (book.editorFontSize ?? 16) * 1.5 })],
        spacing: { line: Math.round(Number(paragraph.lineSpacing) * 240) },
        indent: { firstLine: Math.round(paragraph.indent * (book.editorFontSize ?? 16) * 15) },
      })));
    });
    const documentFile = new Document({ sections: [{ children }] });
    const blob = await Packer.toBlob(documentFile);
    downloadBlob(blob, `${filename}.docx`);
    return;
  }

  if (format === 'pdf') {
    const { jsPDF } = await import('jspdf');
    const pdf = new jsPDF();
    const bodyFont = book.editorFont === 'monospace'
      ? 'courier'
      : book.editorFont === 'sans-serif'
        ? 'helvetica'
        : 'times';
    const margin = 20;
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    let y = margin;
    const writeText = (text, { size, bold = false, gapAfter = 5, font = bodyFont, alignment = 'left', lineSpacing = '1.5', indent = 0 }) => {
      pdf.setFont(font, bold ? 'bold' : 'normal');
      pdf.setFontSize(size);
      const lines = pdf.splitTextToSize(text || ' ', pageWidth - margin * 2);
      const lineHeight = size * 0.42 * Number(lineSpacing);
      const indentMillimeters = indent * size / 0.75 * 25.4 / 72;
      lines.forEach((line, index) => {
        if (y + lineHeight > pageHeight - margin) {
          pdf.addPage();
          y = margin;
        }
        pdf.text(line, margin + (index === 0 ? indentMillimeters : 0), y, { align: alignment });
        y += lineHeight;
      });
      y += gapAfter;
    };

    writeText(book.title, { size: 20, bold: true, gapAfter: 12, font: 'times' });
    chapters.forEach((chapter) => {
      writeText(chapter.title, { size: 16, bold: true, gapAfter: 6, font: 'times' });
      getChapterParagraphs(chapter.source).forEach((paragraph) => {
        writeText(paragraph.text, {
          size: Math.max(8, Math.round((book.editorFontSize ?? 16) * 0.75)),
          gapAfter: 5,
          alignment: paragraph.alignment,
          lineSpacing: paragraph.lineSpacing,
          indent: paragraph.indent,
        });
      });
      y += 8;
    });
    pdf.save(`${filename}.pdf`);
    return;
  }

  throw new Error(`Unsupported manuscript export format: ${format}`);
}

function readWorkspace() {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (!saved) return initialWorkspace;
    const parsed = JSON.parse(saved);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Saved workspace data has an invalid format.');
    }
    return migrateWorkspace(parsed);
  } catch (error) {
    console.error('Could not read the writing workspace from browser storage.', error);
    return initialWorkspace;
  }
}

function Navbar({ session }) {
  const [signOutError, setSignOutError] = useState('');

  const signOut = async () => {
    const { error } = await supabase.auth.signOut();
    if (error) {
      console.error('Could not sign out.', error);
      setSignOutError('Could not sign out. Please try again.');
    }
  };

  return (
    <nav aria-label="Main navigation" className="navbar">
      <Link to="/" className="brand" aria-label="Writing Platform home">
        <span className="brand-mark">w.</span>
        <span className="brand-title">Your Writing Platform</span>
      </Link>
      <ul className="nav-list">
        {session ? (
          <>
            <li><Link to="/dashboard">My workspace</Link></li>
            <li><button onClick={signOut} type="button">Log out</button></li>
          </>
        ) : (
          <>
            <li><Link to="/login">Log in</Link></li>
            <li><Link to="/register">Sign up</Link></li>
          </>
        )}
      </ul>
      {signOutError && <span role="alert">{signOutError}</span>}
    </nav>
  );
}

function Home() {
  return (
    <main className="home-main">
      <section className="hero" aria-label="Writing platform introduction">
        <span className="eyebrow">A home for your next story</span>
        <h1 className="hero-title">Make room for<br /><em>the whole story.</em></h1>
        <p className="hero-desc">
          Draft chapters, get to know your characters, and keep every world-building detail close at hand.
          One calm workspace for the story only you can tell.
        </p>
        <Link to="/dashboard" className="cta-btn">Open your workspace <span aria-hidden="true">↗</span></Link>
        <div className="hero-note"><span className="note-dot" /> Your ideas stay saved on this device</div>
      </section>
      <section className="features" aria-label="Writing workspace features">
        <div className="feature-intro">
          <span className="eyebrow">From first thought to final page</span>
          <h2>Everything your story needs, all in one place.</h2>
        </div>
        <div className="feature-list">
          <article><span>01</span><div><h3>Find your words</h3><p>A focused, distraction-light space for drafting.</p></div></article>
          <article><span>02</span><div><h3>Know your characters</h3><p>Track their wants, flaws, and how they change.</p></div></article>
          <article><span>03</span><div><h3>Keep the details straight</h3><p>Build your world and pin down the plot beats.</p></div></article>
        </div>
      </section>
    </main>
  );
}

function Field({ field, value, onChange, id }) {
  const commonProps = {
    id,
    value: value ?? '',
    onChange: (event) => onChange(event.target.value),
    placeholder: field.placeholder,
    'aria-label': field.label,
  };

  return (
    <label className={`field ${field.multiline ? 'field-wide' : ''}`} htmlFor={id}>
      <span>{field.label}</span>
      {field.options ? (
        <select {...commonProps}>
          <option value="">{field.placeholder}</option>
          {field.options.map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
      ) : field.multiline ? (
        <textarea {...commonProps} rows="3" />
      ) : (
        <input {...commonProps} />
      )}
    </label>
  );
}

function CollectionPanel({ config, items, onAdd, onUpdate, onRemove, onMove, onReviewHighlight }) {
  return (
    <section className="planning-panel" aria-labelledby={`${config.key}-heading`}>
      <div className="section-heading">
        <div>
          <span className="eyebrow">{config.eyebrow}</span>
          <h1 id={`${config.key}-heading`}>{config.title}</h1>
          <p>{config.description}</p>
        </div>
        <button className="primary-button" onClick={onAdd} type="button"><span aria-hidden="true">＋</span> {config.addLabel}</button>
      </div>
      {items.length === 0 ? (
        <div className="empty-state">
          <span className="empty-icon" aria-hidden="true">{config.key === 'scenes' ? '▦' : config.key === 'characters' ? '♙' : config.key === 'world' ? '◎' : '▤'}</span>
          <h2>Your story starts here.</h2>
          <p>Add your first {config.itemLabel.toLowerCase()} to start shaping this part of your story.</p>
          <button className="text-button" onClick={onAdd} type="button">＋ {config.addLabel}</button>
        </div>
      ) : (
        <div className="collection-grid">
          {items.map((item, index) => (
            <article className={`collection-card ${item.highlighted ? 'highlight-note-card' : ''}`} key={item.id}>
              <div className="collection-card-top">
                <span className="card-index">{config.key === 'scenes' ? `SCENE ${String(index + 1).padStart(2, '0')}` : `${config.itemLabel.toUpperCase()} ${String(index + 1).padStart(2, '0')}`}</span>
                <div className="card-actions">
                  {config.key === 'scenes' && (
                    <>
                      <button aria-label={`Move scene ${index + 1} up`} className="icon-button" disabled={index === 0} onClick={() => onMove(index, -1)} type="button">↑</button>
                      <button aria-label={`Move scene ${index + 1} down`} className="icon-button" disabled={index === items.length - 1} onClick={() => onMove(index, 1)} type="button">↓</button>
                    </>
                  )}
                  <button aria-label={`Delete ${config.itemLabel.toLowerCase()} ${index + 1}`} className="icon-button remove-button" onClick={() => onRemove(item.id)} type="button">×</button>
                </div>
              </div>
              {item.highlighted && (
                <div className="saved-highlight">
                  <span>HIGHLIGHTED PASSAGE</span>
                  <blockquote>{item.excerpt}</blockquote>
                  <p>From {item.chapterTitle || 'a chapter'}</p>
                  <button
                    className="review-highlight-button"
                    disabled={!onReviewHighlight}
                    onClick={() => onReviewHighlight?.(item)}
                    title="Open the chapter and select this passage for review"
                    type="button"
                  >
                    Review in chapter ↗
                  </button>
                </div>
              )}
              <div className="fields-grid">
                {config.fields.map((field) => (
                  <Field
                    field={field}
                    id={`${item.id}-${field.name}`}
                    key={field.name}
                    onChange={(value) => onUpdate(item.id, field.name, value)}
                    value={item[field.name]}
                  />
                ))}
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function WritingPanel({
  books,
  activeBook,
  chapters,
  activeChapter,
  spellCheck,
  onConvertDraft,
  onExportManuscript,
  isAddingBook,
  newBookTitle,
  onBookChange,
  onAddBookClick,
  onNewBookTitleChange,
  onAddBookSubmit,
  onCancelAddBook,
  editorFont,
  editorFontSize,
  onEditorFontChange,
  onEditorFontSizeChange,
  onChapterChange,
  onSpellCheckChange,
  onCreateHighlight,
  onAddChapter,
  onUpdateChapter,
}) {
  const manuscriptRef = useRef(null);
  const selectedRangeRef = useRef(null);
  const initialEditorHtmlRef = useRef(null);
  if (initialEditorHtmlRef.current === null) {
    initialEditorHtmlRef.current = activeChapter
      ? activeChapter.contentHtml
        ? sanitizeEditorHtml(activeChapter.contentHtml)
        : plainTextToEditorHtml(activeChapter.content ?? '')
      : '<p><br></p>';
  }
  const [hasSelection, setHasSelection] = useState(false);
  const [selectedAlignment, setSelectedAlignment] = useState('left');
  const [selectedLineSpacing, setSelectedLineSpacing] = useState('1.5');
  const [isExportMenuOpen, setIsExportMenuOpen] = useState(false);
  const [exportStatus, setExportStatus] = useState('');
  const fontFamilies = {
    serif: 'var(--serif)',
    'sans-serif': 'var(--sans)',
    monospace: 'ui-monospace, SFMono-Regular, Consolas, monospace',
  };

  useLayoutEffect(() => {
    const editor = manuscriptRef.current;
    if (!editor) return;
    editor.innerHTML = initialEditorHtmlRef.current;
    selectedRangeRef.current = null;
  }, []);

  const captureSelection = useCallback(() => {
    const editor = manuscriptRef.current;
    const selection = window.getSelection();
    if (!editor || !selection?.rangeCount) {
      selectedRangeRef.current = null;
      setHasSelection(false);
      return null;
    }

    const range = selection.getRangeAt(0);
    if (
      range.collapsed
      || !editor.contains(range.startContainer)
      || !editor.contains(range.endContainer)
      || !range.toString().trim()
    ) {
      selectedRangeRef.current = null;
      setHasSelection(false);
      return null;
    }

    const savedRange = range.cloneRange();
    selectedRangeRef.current = savedRange;
    setHasSelection(true);
    const paragraphs = [...editor.querySelectorAll('p')].filter((paragraph) => savedRange.intersectsNode(paragraph));
    setSelectedAlignment(paragraphs[0]?.style.textAlign || 'left');
    setSelectedLineSpacing(paragraphs[0]?.style.lineHeight || '1.5');
    return savedRange;
  }, []);

  useEffect(() => {
    document.addEventListener('selectionchange', captureSelection);
    return () => document.removeEventListener('selectionchange', captureSelection);
  }, [captureSelection]);

  const saveEditorFormatting = () => {
    const editor = manuscriptRef.current;
    if (!editor || !activeChapter) return;
    const html = sanitizeEditorHtml(editor.innerHTML);
    if (editor.innerHTML !== html) editor.innerHTML = html;
    onUpdateChapter(activeChapter.id, 'content', editorHtmlToPlainText(html));
    onUpdateChapter(activeChapter.id, 'contentHtml', html);
  };

  const applyParagraphStyle = (styleName, value) => {
    const editor = manuscriptRef.current;
    const range = selectedRangeRef.current;
    if (!editor || !range || range.collapsed || !range.toString().trim()) return;
    [...editor.querySelectorAll('p')]
      .filter((paragraph) => range.intersectsNode(paragraph))
      .forEach((paragraph) => { paragraph.style[styleName] = value; });
    saveEditorFormatting();
    captureSelection();
  };

  const adjustIndent = (paragraphs, direction) => {
    if (!paragraphs.length) return;
    paragraphs.forEach((paragraph) => {
      const currentIndent = Number.parseFloat(paragraph.style.textIndent) || 0;
      const nextIndent = Math.min(8, Math.max(0, currentIndent + direction * 2));
      if (nextIndent) paragraph.style.textIndent = `${nextIndent}em`;
      else {
        paragraph.style.removeProperty('text-indent');
        if (!paragraph.style.length) paragraph.removeAttribute('style');
      }
    });
    saveEditorFormatting();
    captureSelection();
  };

  const adjustSelectedIndent = (direction) => {
    const editor = manuscriptRef.current;
    const range = selectedRangeRef.current;
    if (!editor || !range || range.collapsed || !range.toString().trim()) return;
    const paragraphs = [...editor.querySelectorAll('p')].filter((paragraph) => range.intersectsNode(paragraph));
    adjustIndent(paragraphs, direction);
  };

  const handleEditorKeyDown = (event) => {
    const editor = manuscriptRef.current;
    const selection = window.getSelection();
    if (!editor || !selection?.rangeCount) return;
    const range = selection.getRangeAt(0);
    if (!editor.contains(range.startContainer) || !editor.contains(range.endContainer)) return;

    if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey && range.collapsed) {
      const anchor = range.startContainer.nodeType === Node.ELEMENT_NODE
        ? range.startContainer
        : range.startContainer.parentElement;
      const paragraph = anchor?.closest('p');
      if (!paragraph || !editor.contains(paragraph)) return;

      event.preventDefault();
      const paragraphEnd = document.createRange();
      paragraphEnd.selectNodeContents(paragraph);
      paragraphEnd.setStart(range.startContainer, range.startOffset);
      const remainingContent = paragraphEnd.extractContents();
      const nextParagraph = paragraph.cloneNode(false);
      nextParagraph.style.removeProperty('text-indent');
      if (!nextParagraph.style.length) nextParagraph.removeAttribute('style');
      nextParagraph.append(remainingContent);
      if (!paragraph.hasChildNodes()) paragraph.append(document.createElement('br'));
      if (!nextParagraph.hasChildNodes()) nextParagraph.append(document.createElement('br'));
      paragraph.after(nextParagraph);

      const nextRange = document.createRange();
      nextRange.setStart(nextParagraph, 0);
      nextRange.collapse(true);
      selection.removeAllRanges();
      selection.addRange(nextRange);
      handleEditorInput();
      return;
    }

    if (event.key === 'Backspace' && range.collapsed) {
      const anchor = range.startContainer.nodeType === Node.ELEMENT_NODE
        ? range.startContainer
        : range.startContainer.parentElement;
      const paragraph = anchor?.closest('p');
      if (!paragraph || !editor.contains(paragraph) || !paragraph.style.textIndent) return;

      const paragraphStart = document.createRange();
      paragraphStart.selectNodeContents(paragraph);
      paragraphStart.setEnd(range.startContainer, range.startOffset);
      if (paragraphStart.toString()) return;

      event.preventDefault();
      adjustIndent([paragraph], -1);
      return;
    }

    if (event.key !== 'Tab' || event.ctrlKey || event.altKey || event.metaKey) return;

    event.preventDefault();
    let paragraphs;
    if (range.collapsed) {
      const anchor = range.startContainer.nodeType === Node.ELEMENT_NODE
        ? range.startContainer
        : range.startContainer.parentElement;
      const paragraph = anchor?.closest('p')
        ?? (anchor === editor ? editor.children[range.startOffset] : null);
      paragraphs = paragraph?.tagName === 'P' ? [paragraph] : [];
    } else {
      paragraphs = [...editor.querySelectorAll('p')].filter((paragraph) => range.intersectsNode(paragraph));
    }
    adjustIndent(paragraphs, event.shiftKey ? -1 : 1);
  };

  const handleEditorInput = () => {
    const editor = manuscriptRef.current;
    if (!editor || !activeChapter) return;
    const html = sanitizeEditorHtml(editor.innerHTML);
    onUpdateChapter(activeChapter.id, 'content', editorHtmlToPlainText(html));
    onUpdateChapter(activeChapter.id, 'contentHtml', html);
    selectedRangeRef.current = null;
    setHasSelection(false);
  };

  const handleEditorPaste = (event) => {
    event.preventDefault();
    const editor = manuscriptRef.current;
    const selection = window.getSelection();
    if (!editor || !selection?.rangeCount) return;

    const range = selection.getRangeAt(0);
    if (!editor.contains(range.startContainer) || !editor.contains(range.endContainer)) return;
    range.deleteContents();
    const pastedText = event.clipboardData.getData('text/plain');
    if (pastedText) {
      const textNode = document.createTextNode(pastedText);
      range.insertNode(textNode);
      range.setStartAfter(textNode);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    handleEditorInput();
  };

  const alignmentOptions = [
    { value: 'left', label: 'Align left', lines: ['M2 3h12', 'M2 6h8', 'M2 9h12', 'M2 12h7'] },
    { value: 'center', label: 'Align center', lines: ['M2 3h12', 'M4 6h8', 'M2 9h12', 'M5 12h6'] },
    { value: 'right', label: 'Align right', lines: ['M2 3h12', 'M6 6h8', 'M2 9h12', 'M7 12h7'] },
    { value: 'justify', label: 'Justify', lines: ['M2 3h12', 'M2 6h12', 'M2 9h12', 'M2 12h12'] },
  ];

  return (
    <div className="writing-layout">
      <aside className="chapter-sidebar" aria-label="Chapter list">
        <div className="sidebar-heading">
          <span className="eyebrow">{activeBook.isManuscript ? 'Manuscript' : 'Draft'}</span>
          <h2>Chapters <span>{chapters.length}</span></h2>
        </div>
        {activeBook.isManuscript ? (
          <div className="export-control">
            <button
              aria-expanded={isExportMenuOpen}
              className="export-document-button"
              onClick={() => setIsExportMenuOpen(!isExportMenuOpen)}
              type="button"
            >
              <span aria-hidden="true">⇩</span> Export document
            </button>
            {isExportMenuOpen && (
              <div aria-label="Export format" className="export-menu">
                {[
                  ['txt', 'Plain text (.txt)'],
                  ['pdf', 'PDF document (.pdf)'],
                  ['docx', 'Word document (.docx)'],
                ].map(([format, label]) => (
                  <button
                    key={format}
                    onClick={async () => {
                      setExportStatus('Preparing export…');
                      try {
                        await onExportManuscript(format);
                        setExportStatus('Document exported.');
                        setIsExportMenuOpen(false);
                      } catch (error) {
                        console.error(`Could not export the manuscript as ${format}.`, error);
                        setExportStatus('Export failed. Please try again.');
                      }
                    }}
                    type="button"
                  >
                    {label}
                  </button>
                ))}
                <span className="export-status" role="status">{exportStatus}</span>
              </div>
            )}
          </div>
        ) : (
          <button className="convert-draft-button" onClick={onConvertDraft} type="button">
            Convert draft to manuscript
          </button>
        )}
        <div className="book-picker">
          <label htmlFor="book-select">Book</label>
          <select id="book-select" onChange={(event) => onBookChange(event.target.value)} value={activeBook.id}>
            {books.map((book) => <option key={book.id} value={book.id}>{book.title}</option>)}
          </select>
        </div>
        {isAddingBook ? (
          <form className="add-book-form" onSubmit={onAddBookSubmit}>
            <label className="visually-hidden" htmlFor="new-book-title">New book title</label>
            <input
              autoFocus
              id="new-book-title"
              onChange={(event) => onNewBookTitleChange(event.target.value)}
              placeholder="Book title"
              required
              value={newBookTitle}
            />
            <div>
              <button className="text-button" type="submit">Create</button>
              <button className="cancel-book-button" onClick={onCancelAddBook} type="button">Cancel</button>
            </div>
          </form>
        ) : (
          <button className="add-book-button" onClick={onAddBookClick} type="button">＋ Add a book</button>
        )}
        <div className="chapter-list">
          {chapters.map((chapter, index) => (
            <button
              aria-current={chapter.id === activeChapter?.id ? 'page' : undefined}
              className={`chapter-item ${chapter.id === activeChapter?.id ? 'chapter-active' : ''}`}
              key={chapter.id}
              onClick={() => onChapterChange(chapter.id)}
              type="button"
            >
              <span className="chapter-number">{String(index + 1).padStart(2, '0')}</span>
              <span className="chapter-name">{chapter.title || `Chapter ${index + 1}`}</span>
            </button>
          ))}
        </div>
        <button className="add-chapter-button" onClick={onAddChapter} type="button">＋ Add a chapter</button>
        {!activeBook.isManuscript && (
          <p className="convert-hint">Turn this draft into a manuscript when it’s ready to export.</p>
        )}
        <div className="sidebar-tip"><span aria-hidden="true">✦</span><p>Small pages add up to big stories. Keep going.</p></div>
      </aside>

      <section className="writing-panel" aria-label="Chapter editor">
        <div className="writing-topline">
          <span className="eyebrow">The writing room</span>
          <span className="draft-label"><span className="draft-dot" />{activeBook.isManuscript ? 'Manuscript' : 'Draft'}</span>
        </div>
        {activeChapter ? (
          <>
            <input
              aria-label="Chapter title"
              className="chapter-title-input"
              onChange={(event) => onUpdateChapter(activeChapter.id, 'title', event.target.value)}
              placeholder="Untitled chapter"
              value={activeChapter.title}
            />
            <div className="writing-divider" />
            <div className="writing-toolbar" aria-label="Text formatting options">
              <label className="toolbar-field">
                <span>Font</span>
                <select aria-label="Font family" onChange={(event) => onEditorFontChange(event.target.value)} value={editorFont}>
                  <option value="serif">Serif</option>
                  <option value="sans-serif">Sans-serif</option>
                  <option value="monospace">Monospace</option>
                </select>
              </label>
              <label className="toolbar-field toolbar-size">
                <span>Size (pt)</span>
                <select
                  aria-label="Font size in points"
                  onChange={(event) => onEditorFontSizeChange(Number(event.target.value))}
                  title="Recommended print-book and standard manuscript sizes"
                  value={editorFontSize}
                >
                  <option value={13.333333}>10</option>
                  <option value={14}>10.5</option>
                  <option value={14.666667}>11</option>
                  <option value={15.333333}>11.5</option>
                  <option value={16}>12 (standard manuscript)</option>
                </select>
              </label>
              <div aria-label="Alignment for selected paragraphs" className="alignment-tools" role="toolbar">
                <span className="alignment-tools-label">Align</span>
                {alignmentOptions.map((option) => (
                  <button
                    aria-label={option.label}
                    aria-pressed={hasSelection && selectedAlignment === option.value}
                    className={`editor-tool-button alignment-button ${hasSelection && selectedAlignment === option.value ? 'editor-tool-active' : ''}`}
                    disabled={!hasSelection}
                    key={option.value}
                    onClick={() => applyParagraphStyle('textAlign', option.value)}
                    onMouseDown={(event) => event.preventDefault()}
                    title={`${option.label} for selected paragraph${selectedAlignment === option.value ? ' (current)' : ''}`}
                    type="button"
                  >
                    <svg aria-hidden="true" fill="none" viewBox="0 0 16 16">
                      {option.lines.map((line) => <path d={line} key={line} stroke="currentColor" strokeLinecap="round" strokeWidth="1.5" />)}
                    </svg>
                  </button>
                ))}
              </div>
              <div aria-label="Indent selected paragraphs" className="alignment-tools indent-tools" role="toolbar">
                <span className="alignment-tools-label">Indent</span>
                <button
                  aria-label="Decrease indent"
                  className="editor-tool-button alignment-button"
                  disabled={!hasSelection}
                  onClick={() => adjustSelectedIndent(-1)}
                  onMouseDown={(event) => event.preventDefault()}
                  title="Decrease indent for selected paragraph(s)"
                  type="button"
                >
                  <svg aria-hidden="true" fill="none" viewBox="0 0 16 16">
                    <path d="M7 3h7M7 6h7M7 9h7M7 12h7M2 8l3-3v6L2 8Z" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.3" />
                  </svg>
                </button>
                <button
                  aria-label="Increase indent"
                  className="editor-tool-button alignment-button"
                  disabled={!hasSelection}
                  onClick={() => adjustSelectedIndent(1)}
                  onMouseDown={(event) => event.preventDefault()}
                  title="Increase indent for selected paragraph(s)"
                  type="button"
                >
                  <svg aria-hidden="true" fill="none" viewBox="0 0 16 16">
                    <path d="M7 3h7M7 6h7M7 9h7M7 12h7M5 8 2 5v6l3-3Z" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.3" />
                  </svg>
                </button>
              </div>
              <label className="toolbar-field">
                <span>Line spacing</span>
                <select
                  aria-label="Line spacing"
                  disabled={!hasSelection}
                  onChange={(event) => {
                    setSelectedLineSpacing(event.target.value);
                    applyParagraphStyle('lineHeight', event.target.value);
                  }}
                  title="Set line spacing for selected paragraph(s)"
                  value={selectedLineSpacing}
                >
                  <option value="1">Single</option>
                  <option value="1.15">1.15</option>
                  <option value="1.5">1.5</option>
                  <option value="2">Double</option>
                </select>
              </label>
              <span className="toolbar-divider" aria-hidden="true" />
              <button
                aria-pressed={spellCheck}
                className={`editor-tool-button ${spellCheck ? 'editor-tool-active' : ''}`}
                onClick={() => onSpellCheckChange(!spellCheck)}
                title="Uses your browser's spelling tools. Grammar suggestions depend on browser and language support."
                type="button"
                onMouseDown={(event) => event.preventDefault()}
              >
                Aa <span>Spelling &amp; grammar {spellCheck ? 'on' : 'off'}</span>
              </button>
              <button
                className="editor-tool-button"
                disabled={!hasSelection}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  const editor = manuscriptRef.current;
                  const range = selectedRangeRef.current;
                  if (editor && range && range.toString().trim()) {
                    const excerpt = range.toString();
                    const { start, end } = getTextOffsets(editor, range);
                    onCreateHighlight({
                      excerpt,
                      start,
                      end,
                      chapterId: activeChapter.id,
                      chapterTitle: activeChapter.title || 'Untitled chapter',
                    });
                  }
                }}
                title="Select a passage, then save it to Notes so you can return to it later."
                type="button"
              >
                ✦ <span>Highlight → Notes</span>
              </button>
            </div>
            <div
              aria-label="Chapter content"
              aria-multiline="true"
              className={`manuscript-input ${activeChapter.content ? '' : 'manuscript-empty'}`}
              contentEditable
              data-placeholder="The first sentence is yours. Start wherever the story begins…"
              data-empty={activeChapter.content ? 'false' : 'true'}
              onKeyDown={handleEditorKeyDown}
              onInput={handleEditorInput}
              onMouseUp={captureSelection}
              onKeyUp={captureSelection}
              onPaste={handleEditorPaste}
              ref={manuscriptRef}
              role="textbox"
              spellCheck={spellCheck}
              lang="en"
              style={{
                fontFamily: fontFamilies[editorFont] ?? fontFamilies.serif,
                fontSize: `${editorFontSize}px`,
              }}
              suppressContentEditableWarning
            />
            <div className="writing-footer">
              <span title="Character count includes spaces and punctuation; line breaks are excluded">
                {`${activeChapter.content.trim() ? activeChapter.content.trim().split(/\s+/).length : 0} words · ${activeChapter.content.replace(/\r?\n/g, '').length} characters`}
              </span>
              <div className="writing-footer-actions">
                <button
                  className="clear-button"
                  onClick={() => {
                    if (manuscriptRef.current) manuscriptRef.current.innerHTML = '<p><br></p>';
                    selectedRangeRef.current = null;
                    setHasSelection(false);
                    onUpdateChapter(activeChapter.id, 'content', '');
                    onUpdateChapter(activeChapter.id, 'contentHtml', '');
                  }}
                  type="button"
                >
                  Clear chapter
                </button>
                {exportStatus && <span className="export-status" role="status">{exportStatus}</span>}
              </div>
            </div>
          </>
        ) : (
          <div className="empty-state chapter-empty">
            <h2>Ready when you are.</h2>
            <p>Create a chapter to begin drafting.</p>
            <button className="text-button" onClick={onAddChapter} type="button">＋ Add a chapter</button>
          </div>
        )}
      </section>
    </div>
  );
}

function ThemeSwitch({ theme, onChange }) {
  const options = [
    { value: 'light', label: 'Light', icon: '☼' },
    { value: 'dark', label: 'Dark', icon: '☾' },
    { value: 'sepia', label: 'Sepia', icon: '◒' },
  ];

  return (
    <div aria-label="Background colour scheme" className="theme-switch" role="group">
      {options.map((option) => (
        <button
          aria-label={`${option.label} mode`}
          aria-pressed={theme === option.value}
          className={`theme-option ${theme === option.value ? 'theme-option-active' : ''}`}
          key={option.value}
          onClick={() => onChange(option.value)}
          title={`${option.label} mode`}
          type="button"
        >
          <span aria-hidden="true">{option.icon}</span>
          <span className="theme-option-label">{option.label}</span>
        </button>
      ))}
    </div>
  );
}

function Dashboard({ userId }) {
  const [workspace, setWorkspace] = useState(initialWorkspace);
  const [workspaceReady, setWorkspaceReady] = useState(false);
  const [workspaceLoadError, setWorkspaceLoadError] = useState('');
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [activeTab, setActiveTab] = useState('write');
  const [saveStatus, setSaveStatus] = useState('Loading your workspace…');
  const [isAddingBook, setIsAddingBook] = useState(false);
  const [newBookTitle, setNewBookTitle] = useState('');
  const pendingReviewRef = useRef(null);
  const saveQueueRef = useRef(Promise.resolve());
  const saveRevisionRef = useRef(0);

  useEffect(() => {
    let current = true;

    const loadWorkspace = async () => {
      setWorkspaceReady(false);
      setWorkspaceLoadError('');
      try {
        const { data, error } = await supabase
          .from('user_workspaces')
          .select('workspace')
          .eq('user_id', userId)
          .maybeSingle();
        if (error) throw error;

        if (data) {
          if (!data.workspace || typeof data.workspace !== 'object' || Array.isArray(data.workspace)) {
            throw new Error('The saved workspace has an invalid format.');
          }
          if (current) setWorkspace(migrateWorkspace(data.workspace));
        } else if (current) {
          setWorkspace(readWorkspace());
        }

        if (current) {
          setWorkspaceReady(true);
          setSaveStatus(data ? 'Loaded from cloud' : 'Saving to cloud…');
        }
      } catch (error) {
        console.error('Could not load the writing workspace from Supabase.', error);
        if (current) {
          setWorkspaceLoadError('Could not load your workspace. Check your connection and try again.');
          setSaveStatus('Could not load from cloud');
        }
      }
    };

    loadWorkspace();
    return () => { current = false; };
  }, [userId, loadAttempt]);

  useEffect(() => {
    document.documentElement.dataset.theme = workspace.theme;
  }, [workspace.theme]);

  useEffect(() => {
    if (!workspaceReady) return undefined;

    const timeout = window.setTimeout(() => {
      const revision = ++saveRevisionRef.current;
      setSaveStatus('Saving to cloud…');
      saveQueueRef.current = saveQueueRef.current
        .then(async () => {
          const { error } = await supabase.from('user_workspaces').upsert({
            user_id: userId,
            workspace,
            updated_at: new Date().toISOString(),
          }, { onConflict: 'user_id' });
          if (error) throw error;
          if (revision === saveRevisionRef.current) setSaveStatus('Saved to cloud');
        })
        .catch((error) => {
          console.error('Could not save the writing workspace to Supabase.', error);
          if (revision === saveRevisionRef.current) setSaveStatus('Could not save to cloud');
        });
    }, 350);

    return () => window.clearTimeout(timeout);
  }, [workspace, userId, workspaceReady]);

  const updateWorkspace = (updater) => {
    setSaveStatus('Saving…');
    setWorkspace((current) => typeof updater === 'function' ? updater(current) : { ...current, ...updater });
  };

  const updateActiveBook = (updater) => {
    updateWorkspace((current) => ({
      ...current,
      books: current.books.map((book) => {
        if (book.id !== current.activeBookId) return book;
        return typeof updater === 'function' ? updater(book) : { ...book, ...updater };
      }),
    }));
  };

  const activeBook = workspace.books.find((book) => book.id === workspace.activeBookId) ?? workspace.books[0];
  const switchBook = (bookId) => updateWorkspace({ activeBookId: bookId });

  useEffect(() => {
    const pending = pendingReviewRef.current;
    if (
      !pending
      || activeTab !== 'write'
      || activeBook.id !== pending.bookId
      || activeBook.activeChapterId !== pending.chapterId
    ) return undefined;

    const frame = window.requestAnimationFrame(() => {
      const editor = document.querySelector('.manuscript-input');
      if (!(editor instanceof HTMLElement)) return;

      const textNodes = [];
      const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) textNodes.push(walker.currentNode);
      const editorText = textNodes.map((node) => node.textContent ?? '').join('');
      let start = Math.min(pending.start, editorText.length);
      if (editorText.slice(start, start + pending.excerpt.length) !== pending.excerpt) {
        const relocatedStart = editorText.indexOf(pending.excerpt);
        if (relocatedStart >= 0) start = relocatedStart;
      }
      const range = createRangeAtTextOffsets(editor, start, start + pending.excerpt.length);
      if (!range) return;
      editor.focus();
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      editor.scrollIntoView({ behavior: 'smooth', block: 'center' });
      pendingReviewRef.current = null;
    });

    return () => window.cancelAnimationFrame(frame);
  }, [activeBook.id, activeBook.activeChapterId, activeTab]);

  const addBook = (event) => {
    event.preventDefault();
    const title = newBookTitle.trim();
    if (!title) return;

    const book = createBook(`book-${Date.now()}`, title);
    updateWorkspace((current) => ({
      ...current,
      books: [...current.books, book],
      activeBookId: book.id,
    }));
    setActiveTab('write');
    setNewBookTitle('');
    setIsAddingBook(false);
  };

  const addChapter = () => {
    updateActiveBook((current) => {
      const chapter = { id: `${current.id}-chapter-${Date.now()}`, title: `Chapter ${current.chapters.length + 1}`, content: '' };
      return { ...current, chapters: [...current.chapters, chapter], activeChapterId: chapter.id };
    });
  };

  const updateChapter = (id, field, value) => {
    updateActiveBook((current) => ({
      ...current,
      chapters: current.chapters.map((chapter) => chapter.id === id ? { ...chapter, [field]: value } : chapter),
    }));
  };

  const createHighlight = ({ excerpt, start, end, chapterId, chapterTitle }) => {
    const note = {
      id: `highlight-${Date.now()}`,
      title: `Review: ${excerpt.trim().slice(0, 48)}${excerpt.trim().length > 48 ? '…' : ''}`,
      kind: 'Highlighted passage',
      body: 'Return to this passage and review it in context.',
      highlighted: true,
      excerpt,
      start,
      end,
      chapterId,
      chapterTitle,
    };
    updateActiveBook((current) => ({ ...current, notes: [...current.notes, note] }));
    setActiveTab('notes');
  };

  const reviewHighlight = (note) => {
    const chapter = activeBook.chapters.find((item) => item.id === note.chapterId);
    if (!chapter) return;
    pendingReviewRef.current = {
      bookId: activeBook.id,
      chapterId: chapter.id,
      start: note.start,
      end: note.end,
      excerpt: note.excerpt,
    };
    updateActiveBook({ activeChapterId: chapter.id });
    setActiveTab('write');
  };

  const activeChapter = activeBook.chapters.find((chapter) => chapter.id === activeBook.activeChapterId);
  const collectionKey = activeTab === 'storyboard' ? 'scenes' : activeTab;
  const config = collections[collectionKey];

  const addItem = () => {
    const item = { id: `${collectionKey}-${Date.now()}` };
    config.fields.forEach((field) => { item[field.name] = ''; });
    updateActiveBook((current) => ({ ...current, [collectionKey]: [...current[collectionKey], item] }));
  };

  const updateItem = (id, field, value) => {
    updateActiveBook((current) => ({
      ...current,
      [collectionKey]: current[collectionKey].map((item) => item.id === id ? { ...item, [field]: value } : item),
    }));
  };

  const removeItem = (id) => {
    updateActiveBook((current) => ({
      ...current,
      [collectionKey]: current[collectionKey].filter((item) => item.id !== id),
    }));
  };

  const moveScene = (index, direction) => {
    updateActiveBook((current) => {
      const scenes = [...current.scenes];
      const target = index + direction;
      [scenes[index], scenes[target]] = [scenes[target], scenes[index]];
      return { ...current, scenes };
    });
  };

  const convertDraft = () => {
    updateActiveBook({ isManuscript: true, convertedAt: new Date().toISOString() });
  };

  if (!workspaceReady) {
    return (
      <main className="auth-page">
        <h1>{workspaceLoadError ? 'Workspace unavailable' : 'Loading your workspace…'}</h1>
        {workspaceLoadError && (
          <>
            <p role="alert">{workspaceLoadError}</p>
            <button className="cta-btn" onClick={() => setLoadAttempt((attempt) => attempt + 1)} type="button">Try again</button>
          </>
        )}
      </main>
    );
  }

  return (
    <main className="workspace">
      <header className="workspace-header">
        <div>
          <div className="breadcrumb"><span>MY STORIES</span><span aria-hidden="true">/</span><span>{activeBook.title}</span></div>
          <h1>Your writing room</h1>
          <p>Working on <strong>{activeBook.title}</strong> · every part of your story, right where you need it.</p>
        </div>
        <div className="workspace-header-tools">
          <ThemeSwitch theme={workspace.theme} onChange={(theme) => updateWorkspace({ theme })} />
          <div className="save-indicator" role="status"><span className={saveStatus.startsWith('Could not') ? 'save-dot save-error' : 'save-dot'} />{saveStatus}</div>
        </div>
      </header>

      <div className="workspace-tabs" role="tablist" aria-label="Story workspace">
        {planningTabs.map((tab) => (
          <button
            aria-controls="workspace-tabpanel"
            aria-selected={activeTab === tab.id}
            className={`workspace-tab ${activeTab === tab.id ? 'tab-active' : ''}`}
            id={`tab-${tab.id}`}
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            role="tab"
            type="button"
          >
            <span aria-hidden="true">{tab.icon}</span>{tab.label}
          </button>
        ))}
      </div>

      <div aria-labelledby={`tab-${activeTab}`} className="workspace-tabpanel" id="workspace-tabpanel" role="tabpanel">
        {activeTab === 'write' ? (
          <WritingPanel
            key={`${activeBook.id}-${activeChapter?.id ?? 'empty'}`}
            activeBook={activeBook}
            activeChapter={activeChapter}
            books={workspace.books}
            chapters={activeBook.chapters}
            editorFont={activeBook.editorFont ?? initialBook.editorFont}
            editorFontSize={activeBook.editorFontSize ?? initialBook.editorFontSize}
            spellCheck={activeBook.spellCheck !== false}
            onAddChapter={addChapter}
            onAddBookClick={() => setIsAddingBook(true)}
            onAddBookSubmit={addBook}
            onBookChange={switchBook}
            onCancelAddBook={() => { setIsAddingBook(false); setNewBookTitle(''); }}
            onChapterChange={(id) => updateActiveBook({ activeChapterId: id })}
            onEditorFontChange={(editorFont) => updateActiveBook({ editorFont })}
            onEditorFontSizeChange={(editorFontSize) => updateActiveBook({ editorFontSize })}
            onSpellCheckChange={(spellCheck) => updateActiveBook({ spellCheck })}
            onConvertDraft={convertDraft}
            onExportManuscript={(format) => exportManuscript(activeBook, format)}
            onCreateHighlight={createHighlight}
            onNewBookTitleChange={setNewBookTitle}
            onUpdateChapter={updateChapter}
            isAddingBook={isAddingBook}
            newBookTitle={newBookTitle}
          />
        ) : (
          <CollectionPanel
            config={config}
            items={activeBook[collectionKey]}
            onAdd={addItem}
            onMove={moveScene}
            onRemove={removeItem}
            onUpdate={updateItem}
            onReviewHighlight={collectionKey === 'notes' ? reviewHighlight : undefined}
          />
        )}
      </div>
    </main>
  );
}

function AuthPage({ register = false }) {
  const navigate = useNavigate();
  const [message, setMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    setMessage('');
    setErrorMessage('');
    if (!supabase) {
      setErrorMessage('Cloud accounts are not configured yet. Add the Supabase URL and public anon key to the app environment.');
      return;
    }

    const formData = new FormData(event.currentTarget);
    const email = formData.get('email');
    const password = formData.get('password');
    setIsSubmitting(true);
    try {
      const { data, error } = register
        ? await supabase.auth.signUp({ email, password })
        : await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;

      if (register && !data.session) {
        setMessage('Check your email for a confirmation link, then log in to continue.');
      } else {
        navigate('/dashboard', { replace: true });
      }
    } catch (error) {
      console.error(`Could not ${register ? 'register' : 'log in'}.`, error);
      setErrorMessage(error.message || 'Authentication failed. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <main className="auth-page">
      <span className="eyebrow">{register ? 'Start writing' : 'Welcome back'}</span>
      <h1>{register ? 'Make a little room for your story.' : 'Pick up where your story left off.'}</h1>
      <p>{register ? 'Create an account to save your writing to your cloud workspace.' : 'Log in to continue to your cloud workspace.'}</p>
      <form aria-label={register ? 'Register form' : 'Login form'} className="auth-form" onSubmit={submit}>
        <label htmlFor="auth-email">Email</label>
        <input autoComplete="username" id="auth-email" name="email" required type="email" />
        <label htmlFor="auth-password">Password</label>
        <input autoComplete={register ? 'new-password' : 'current-password'} id="auth-password" minLength="8" name="password" required type="password" />
        <button className="cta-btn" disabled={isSubmitting} type="submit">{isSubmitting ? 'Please wait…' : register ? 'Create account' : 'Log in'}</button>
      </form>
      {message && <p role="status">{message}</p>}
      {errorMessage && <p role="alert">{errorMessage}</p>}
      <Link className="auth-workspace-link" to={register ? '/login' : '/register'}>
        {register ? 'Already have an account? Log in' : 'Need an account? Sign up'}
      </Link>
    </main>
  );
}

function Footer() {
  const [activeSection, setActiveSection] = useState(null);
  const sections = {
    terms: {
      title: 'Terms of service',
      content: (
        <>
          <p><strong>Planned service terms — not yet in effect.</strong> This prototype does not currently provide working accounts or cloud storage. These terms describe the intended service and must be finalized before account features launch.</p>
          <p>When available, you will be able to create an account to use the writing workspace. You will retain ownership of the writing and other content you create. You are responsible for keeping your account credentials private and using the service lawfully.</p>
          <p>The service will use its hosting and service providers to operate and protect accounts and saved work. It will not sell your personal information. The service may change as it develops; final terms will explain account closure, data handling, and service availability.</p>
        </>
      ),
    },
    privacy: {
      title: 'Privacy policy',
      content: (
        <>
          <p><strong>Planned privacy policy — account features are not live yet.</strong> When accounts launch, account details you provide (such as your email address and sign-in credentials) will be used to create, secure, and manage your account and provide the writing service.</p>
          <p>Your books, drafts, and planning data will be stored and processed by the hosting provider and any service providers needed to run the platform. Those providers may handle information on the platform’s behalf. Reasonable safeguards will be selected and configured with the host, but no online service can promise absolute security.</p>
          <p>We will not sell your personal information. Information will be used to operate, maintain, and support the service. We may occasionally email you about offers for the service; you can opt out of promotional emails. Essential account or service messages may still be sent.</p>
          <p>When cloud accounts are configured, account details are handled by Supabase Authentication and each signed-in user’s workspace is stored in the connected Supabase project. The project owner and service provider may be able to access stored data. Newsreader and DM Sans fonts are loaded from Google Fonts, which receives the connection needed to deliver them. Before inviting testers, confirm the applicable privacy rights, retention, contact details, and provider settings.</p>
        </>
      ),
    },
    attributions: {
      title: 'Attributions',
      content: (
        <>
          <p>Typography: <a href="https://fonts.google.com/specimen/Newsreader" rel="noreferrer" target="_blank">Newsreader</a> and <a href="https://fonts.google.com/specimen/DM+Sans" rel="noreferrer" target="_blank">DM Sans</a>, served by Google Fonts.</p>
          <p>These typefaces are distributed under the SIL Open Font License. Visit each font’s page for its license and specimen details.</p>
        </>
      ),
    },
    credits: {
      title: 'Credits',
      content: (
        <>
          <p>Built with <a href="https://react.dev/" rel="noreferrer" target="_blank">React</a>, <a href="https://reactrouter.com/" rel="noreferrer" target="_blank">React Router</a>, and <a href="https://vite.dev/" rel="noreferrer" target="_blank">Vite</a>.</p>
          <p>Each open-source project retains its own name, copyright, and license.</p>
        </>
      ),
    },
  };

  return (
    <footer className="footer">
      <div className="footer-content">
        <div className="footer-main">
          <div className="footer-brand">
            <span className="footer-mark">w.</span>
            <div>
              <strong>Your Writing Platform</strong>
              <span>A little more room for your imagination.</span>
            </div>
          </div>
          <nav aria-label="Footer information" className="footer-links">
            {Object.entries(sections).map(([key, section]) => (
              <button
                aria-controls="footer-information"
                aria-expanded={activeSection === key}
                className={activeSection === key ? 'footer-link footer-link-active' : 'footer-link'}
                key={key}
                onClick={() => setActiveSection(activeSection === key ? null : key)}
                type="button"
              >
                {section.title}
              </button>
            ))}
          </nav>
        </div>

        <section className="donate-message" aria-label="Support this project">
          <span className="donate-icon" aria-hidden="true">♡</span>
          <p><strong>Enjoying your writing space?</strong> Your support helps this project grow. Donation options are coming soon.</p>
        </section>

        {activeSection && (
          <section aria-live="polite" className="footer-information" id="footer-information">
            <div className="footer-information-heading">
              <h2>{sections[activeSection].title}</h2>
              <button aria-label="Close information" className="footer-close" onClick={() => setActiveSection(null)} type="button">×</button>
            </div>
            <div className="footer-information-copy">{sections[activeSection].content}</div>
          </section>
        )}

        <div className="footer-bottom">
          <span>© {new Date().getFullYear()} Your Writing Platform. All rights reserved.</span>
          <span className="footer-watermark" aria-hidden="true">YOUR WRITING PLATFORM</span>
          <span>Made for the stories ahead.</span>
        </div>
      </div>
    </footer>
  );
}

function App() {
  const [session, setSession] = useState(null);
  const [authReady, setAuthReady] = useState(!supabase);

  useEffect(() => {
    if (!supabase) return undefined;

    let current = true;
    supabase.auth.getSession().then(({ data, error }) => {
      if (error) {
        console.error('Could not restore the sign-in session.', error);
      }
      if (current) {
        setSession(data?.session ?? null);
        setAuthReady(true);
      }
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
    });

    return () => {
      current = false;
      subscription.unsubscribe();
    };
  }, []);

  return (
    <Router>
      <header><Navbar session={session} /></header>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/dashboard" element={
          !authReady
            ? <main className="auth-page"><h1>Loading…</h1></main>
            : session
              ? <Dashboard key={session.user.id} userId={session.user.id} />
              : <Navigate to="/login" replace />
        } />
        <Route path="/login" element={
          !authReady
            ? <main className="auth-page"><h1>Loading…</h1></main>
            : session
              ? <Navigate to="/dashboard" replace />
              : <AuthPage />
        } />
        <Route path="/register" element={
          !authReady
            ? <main className="auth-page"><h1>Loading…</h1></main>
            : session
              ? <Navigate to="/dashboard" replace />
              : <AuthPage register />
        } />
      </Routes>
      <Footer />
    </Router>
  );
}

export default App;
