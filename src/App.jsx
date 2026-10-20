import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { HashRouter as Router, Routes, Route, Link, Navigate, useNavigate } from 'react-router-dom';
import { supabase } from './lib/supabase';
import './App.css';

const STORAGE_KEY = 'writing-platform-workspace';
const LOCAL_PREVIEW_WORKSPACE_KEY = 'writing-platform-local-preview-workspace';
const DAILY_GOAL_STORAGE_PREFIX = 'writing-platform-daily-goal';
const LOCAL_PREVIEW_PROFILE_KEY = 'writing-platform-local-preview-profile';
const BOOK_COVER_BUCKET = 'book-covers';
const MAX_BOOK_COVER_BYTES = 5 * 1024 * 1024;
const AUTO_PAGE_CHAR_LIMIT = 2000;
const AUTO_PAGE_SPLIT_DELAY = 100;

function countWords(text = '') {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

function splitEditorIntoPages(editor, limit) {
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
  let nonSpaceCount = 0;
  const boundaries = [];

  while (walker.nextNode()) {
    const node = walker.currentNode;

    for (let offset = 0; offset < node.length;) {
      const codePoint = node.data.codePointAt(offset);
      const character = String.fromCodePoint(codePoint);

      if (!/\s/u.test(character)) {
        nonSpaceCount += 1;
        if (nonSpaceCount % limit === 0) boundaries.push({ node, offset: offset + character.length });
      }
      offset += character.length;
    }
  }

  if (!boundaries.length) return null;

  const htmlForRange = (range) => {
    const wrapper = document.createElement('div');
    wrapper.append(range.cloneContents());
    return sanitizeEditorHtml(wrapper.innerHTML);
  };
  const chunks = [];
  let startNode = editor;
  let startOffset = 0;

  boundaries.forEach(({ node, offset }) => {
    const range = document.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(node, offset);
    chunks.push(htmlForRange(range));
    startNode = node;
    startOffset = offset;
  });

  const remaining = document.createRange();
  remaining.setStart(startNode, startOffset);
  remaining.setEnd(editor, editor.childNodes.length);
  const remainingHtml = htmlForRange(remaining);
  chunks.push(nonSpaceCount % limit === 0 ? '<p><br></p>' : remainingHtml);
  return chunks;
}

function editorHasReachedPageLimit(editor, limit) {
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
  let nonSpaceCount = 0;

  while (walker.nextNode()) {
    for (const character of walker.currentNode.data) {
      if (!/\s/u.test(character) && ++nonSpaceCount >= limit) return true;
    }
  }

  return false;
}

function getDailyWordCounts(workspace) {
  return Object.fromEntries(workspace.books.flatMap((book) => book.chapters.map((chapter) => [
    `${book.id}:${chapter.id}`,
    countWords((chapter.pages ?? [{ content: chapter.content ?? '' }]).map((page) => page.content ?? '').join('\n')),
  ])));
}

function localDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function readDailyGoalState(userId, wordCounts) {
  const date = localDateKey();
  const key = `${DAILY_GOAL_STORAGE_PREFIX}:${userId}`;
  try {
    const saved = JSON.parse(window.localStorage.getItem(key) ?? 'null');
    if (
      saved?.date === date
      && saved.baselineCounts
      && typeof saved.baselineCounts === 'object'
      && Number.isFinite(saved.seconds)
    ) return saved;
  } catch (error) {
    console.error('Could not read daily writing goal progress.', error);
  }

  const state = { date, baselineCounts: wordCounts, seconds: 0 };
  try {
    window.localStorage.setItem(key, JSON.stringify(state));
  } catch (error) {
    console.error('Could not save daily writing goal progress.', error);
  }
  return state;
}

function saveDailyGoalState(userId, state) {
  try {
    window.localStorage.setItem(`${DAILY_GOAL_STORAGE_PREFIX}:${userId}`, JSON.stringify(state));
  } catch (error) {
    console.error('Could not save daily writing goal progress.', error);
  }
}

function makeGoalProgress(goal, dailyState, wordCounts) {
  if (!goal || !['words', 'minutes'].includes(goal.daily_goal_type)) return null;
  const target = Number(goal.daily_goal_target);
  if (!Number.isFinite(target) || target < 1) return null;

  const done = goal.daily_goal_type === 'words'
    ? Object.entries(wordCounts).reduce((total, [chapterKey, words]) => (
      total + Math.max(0, words - (dailyState.baselineCounts[chapterKey] ?? 0))
    ), 0)
    : dailyState.seconds / 60;
  const unit = goal.daily_goal_type === 'words' ? 'words' : 'minutes';
  const displayedDone = goal.daily_goal_type === 'words' ? done : Math.floor(done);
  const label = `${displayedDone} / ${target} ${unit} today`;

  return {
    percent: Math.min(100, Math.round((done / target) * 100)),
    label,
  };
}

function createBook(id, title) {
  const chapterId = `${id}-chapter-1`;
  return {
    id,
    title,
    coverSubtitle: '',
    blurb: '',
    authorName: '',
    coverImagePath: '',
    chapters: [{
      id: chapterId,
      title: 'Chapter 1',
      content: '',
      pages: [{ id: `${chapterId}-page-1`, content: '', contentHtml: '' }],
    }],
    activeChapterId: chapterId,
    activePageId: `${chapterId}-page-1`,
    editorFont: 'serif',
    editorFontSize: 16,
    spellCheck: true,
    isManuscript: false,
    characters: [],
    world: [],
    notes: [],
    scenes: [],
    continuousWriting: false,
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
  const savedChapters = Array.isArray(book.chapters) ? book.chapters : fallback.chapters;
  normalized.chapters = savedChapters.map((chapter, chapterIndex) => {
    const chapterId = typeof chapter.id === 'string' ? chapter.id : `${fallback.id}-chapter-${chapterIndex + 1}`;
    const pages = Array.isArray(chapter.pages) && chapter.pages.length
      ? chapter.pages.map((page, pageIndex) => ({
        ...page,
        id: typeof page.id === 'string' ? page.id : `${chapterId}-page-${pageIndex + 1}`,
        content: typeof page.content === 'string' ? page.content : '',
        contentHtml: typeof page.contentHtml === 'string' ? page.contentHtml : '',
      }))
      : [{
        id: `${chapterId}-page-1`,
        content: typeof chapter.content === 'string' ? chapter.content : '',
        contentHtml: typeof chapter.contentHtml === 'string' ? chapter.contentHtml : '',
      }];
    return {
      ...chapter,
      id: chapterId,
      pages,
      content: pages[0].content,
      contentHtml: pages[0].contentHtml,
    };
  });
  normalized.activeChapterId = normalized.chapters.some((chapter) => chapter.id === book.activeChapterId)
    ? book.activeChapterId
    : normalized.chapters[0]?.id ?? null;
  const activeChapter = normalized.chapters.find((chapter) => chapter.id === normalized.activeChapterId);
  normalized.activePageId = activeChapter?.pages.some((page) => page.id === book.activePageId)
    ? book.activePageId
    : activeChapter?.pages[0]?.id ?? null;
  normalized.characters = Array.isArray(book.characters) ? book.characters : [];
  normalized.world = Array.isArray(book.world) ? book.world : [];
  normalized.notes = Array.isArray(book.notes) ? book.notes : [];
  normalized.scenes = Array.isArray(book.scenes) ? book.scenes : [];
  normalized.spellCheck = book.spellCheck !== false;
  normalized.coverSubtitle = typeof book.coverSubtitle === 'string' ? book.coverSubtitle : '';
  normalized.blurb = typeof book.blurb === 'string' ? book.blurb : '';
  normalized.authorName = typeof book.authorName === 'string' ? book.authorName : '';
  normalized.coverImagePath = typeof book.coverImagePath === 'string' ? book.coverImagePath : '';
  normalized.continuousWriting = book.continuousWriting === true;
  return normalized;
}

function migrateWorkspace(saved) {
  if (Array.isArray(saved.books) && saved.books.length > 0) {
    const books = saved.books.map(normalizeBook);
    return {
      books,
      activeBookId: books.some((book) => book.id === saved.activeBookId) ? saved.activeBookId : books[0].id,
      theme: ['light', 'dark', 'sepia', 'pestel', 'stardust', 'lavender'].includes(saved.theme)
        ? saved.theme
        : 'sepia',
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
    if (
      paragraph.tagName === 'P'
      && paragraph.childElementCount === 1
      && paragraph.firstElementChild.tagName === 'BR'
      && !paragraph.textContent
    ) return '';
    return textFromEditorNode(paragraph);
  }).join('\n');
}

function getContentParagraphs(content) {
  const html = content.contentHtml
    ? sanitizeEditorHtml(content.contentHtml)
    : plainTextToEditorHtml(content.content ?? '');
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

function getChapterParagraphs(chapter) {
  return (chapter.pages ?? [chapter]).flatMap(getContentParagraphs);
}

function getChapterPlainText(chapter) {
  return (chapter.pages ?? [chapter]).map((page) => page.content ?? '').join('\n');
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
    content: getChapterPlainText(chapter),
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
      : ['sans-serif', 'arial'].includes(book.editorFont)
        ? 'Arial'
        : book.editorFont === 'times-new-roman'
          ? 'Times New Roman'
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
      : ['sans-serif', 'arial'].includes(book.editorFont)
        ? 'helvetica'
        : 'times';
    const margin = 20;
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    let y = margin;
    const addPage = () => {
      pdf.addPage();
      y = margin;
    };
    const writeText = (text, { size, bold = false, gapAfter = 5, font = bodyFont, alignment = 'left', lineSpacing = '1.5', indent = 0 }) => {
      pdf.setFont(font, bold ? 'bold' : 'normal');
      pdf.setFontSize(size);
      const lines = pdf.splitTextToSize(text || ' ', pageWidth - margin * 2);
      const lineHeight = size * 0.42 * Number(lineSpacing);
      const indentMillimeters = indent * size / 0.75 * 25.4 / 72;
      lines.forEach((line, index) => {
        if (y + lineHeight > pageHeight - margin) {
          addPage();
        }
        pdf.text(line, margin + (index === 0 ? indentMillimeters : 0), y, { align: alignment });
        y += lineHeight;
      });
      y += gapAfter;
    };

    writeText(book.title, { size: 20, bold: true, gapAfter: 12, font: 'times' });
    chapters.forEach((chapter) => {
      addPage();
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

    if (book.notes.length > 0) {
      addPage();
      writeText('Notes', { size: 18, bold: true, gapAfter: 12, font: 'times' });
      book.notes.forEach((note, index) => {
        writeText(note.title?.trim() || `Note ${index + 1}`, { size: 13, bold: true, gapAfter: 3, font: 'times' });
        if (note.kind?.trim()) writeText(note.kind, { size: 9, bold: true, gapAfter: 4 });
        if (note.body?.trim()) writeText(note.body, { size: 10, gapAfter: 5 });
        if (note.excerpt?.trim()) {
          writeText(`Highlighted passage${note.chapterTitle ? ` · ${note.chapterTitle}` : ''}:`, {
            size: 9,
            bold: true,
            gapAfter: 3,
          });
          writeText(note.excerpt, { size: 10, gapAfter: 5 });
        }
        y += 5;
      });
    }

    pdf.save(`${filename}.pdf`);
    return;
  }

  throw new Error(`Unsupported manuscript export format: ${format}`);
}

function readWorkspace(storageKey = STORAGE_KEY) {
  try {
    const saved = window.localStorage.getItem(storageKey);
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

function readLocalPreviewProfile() {
  try {
    const saved = window.localStorage.getItem(LOCAL_PREVIEW_PROFILE_KEY);
    if (!saved) return {};
    const parsed = JSON.parse(saved);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Saved local preview profile has an invalid format.');
    }
    return parsed;
  } catch (error) {
    console.error('Could not read the local preview profile.', error);
    return {};
  }
}

function workspaceLinkLabel(user) {
  const displayName = user?.user_metadata?.display_name?.trim();
  const emailName = user?.email?.split('@')[0]?.trim();
  const name = displayName || emailName;
  return name ? `${name}'s workspace` : 'My workspace';
}

function Navbar({ session, offlinePreview = false }) {
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
        {session || offlinePreview ? (
          <>
            <li className="nav-profile-item">
              <Link to="/dashboard">{offlinePreview ? 'Local preview workspace' : workspaceLinkLabel(session.user)}</Link>
            </li>
            <li><Link to="/profile">Profile settings</Link></li>
            {offlinePreview
              ? <li><Link to="/">Exit preview</Link></li>
              : <li><button onClick={signOut} type="button">Log out</button></li>}
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
      <section className="hero hero-image-banner" aria-label="Writing platform introduction">
        <span className="eyebrow">A home for your next story</span>
        <h1 className="hero-title">Make room for<br /><em>the whole story.</em></h1>
        <p className="hero-desc">
          Draft chapters, get to know your characters, and keep every world-building detail close at hand.
          One calm workspace for the story only you can tell.
        </p>
        <Link to="/dashboard" className="cta-btn">Open your workspace <span aria-hidden="true">↗</span></Link>
        <div className="hero-note"><span className="note-dot" /> Your ideas stay saved on this device</div>
        <span className="hero-image-credit">Photo by Angela Marie · CC BY-NC</span>
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

function BookCoverEditor({ activeBook, userId, offlinePreview, onUpdateBook }) {
  const [signedCoverUrl, setSignedCoverUrl] = useState('');
  const [localCoverUrl, setLocalCoverUrl] = useState('');
  const [coverStatus, setCoverStatus] = useState('');
  const [coverError, setCoverError] = useState('');
  const localCoverUrlRef = useRef('');
  const coverUrl = offlinePreview ? localCoverUrl : signedCoverUrl;

  useEffect(() => () => {
    if (localCoverUrlRef.current) URL.revokeObjectURL(localCoverUrlRef.current);
  }, []);

  useEffect(() => {
    if (offlinePreview || !activeBook.coverImagePath) {
      setSignedCoverUrl('');
      return undefined;
    }

    let current = true;
    setCoverError('');
    supabase.storage
      .from(BOOK_COVER_BUCKET)
      .createSignedUrl(activeBook.coverImagePath, 60 * 60)
      .then(({ data, error }) => {
        if (error) throw error;
        if (current) setSignedCoverUrl(data.signedUrl);
      })
      .catch((error) => {
        console.error('Could not load this book cover from Supabase Storage.', error);
        if (current) setCoverError('Could not load the cover image. Check your connection and storage setup.');
      });

    return () => { current = false; };
  }, [activeBook.coverImagePath, offlinePreview]);

  const updateBookField = (field, value) => onUpdateBook(activeBook.id, { [field]: value });

  const uploadCover = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    setCoverStatus('');
    setCoverError('');
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp', 'image/avif'].includes(file.type)) {
      setCoverError('Choose a JPEG, PNG, WebP, or AVIF image.');
      return;
    }
    if (file.size > MAX_BOOK_COVER_BYTES) {
      setCoverError('Cover images must be 5 MB or smaller.');
      return;
    }

    if (offlinePreview) {
      if (localCoverUrlRef.current) URL.revokeObjectURL(localCoverUrlRef.current);
      const imageUrl = URL.createObjectURL(file);
      localCoverUrlRef.current = imageUrl;
      setLocalCoverUrl(imageUrl);
      return;
    }

    setCoverStatus('Uploading cover…');
    try {
      const imagePath = `${userId}/${activeBook.id}/cover`;
      const { error } = await supabase.storage
        .from(BOOK_COVER_BUCKET)
        .upload(imagePath, file, {
          cacheControl: '3600',
          contentType: file.type,
          upsert: true,
        });
      if (error) throw error;
      const { data: signedImage, error: signedUrlError } = await supabase.storage
        .from(BOOK_COVER_BUCKET)
        .createSignedUrl(imagePath, 60 * 60);
      if (signedUrlError) throw signedUrlError;
      onUpdateBook(activeBook.id, { coverImagePath: imagePath });
      setSignedCoverUrl(signedImage.signedUrl);
      setCoverStatus('Cover uploaded.');
    } catch (error) {
      console.error('Could not upload the book cover.', error);
      setCoverStatus('');
      setCoverError(error.message || 'Could not upload the cover. Please try again.');
    }
  };

  return (
    <section aria-labelledby="book-cover-heading" className="book-cover-editor">
      <h3 id="book-cover-heading">Book cover</h3>
      <label className="book-cover-field">
        <span>Title</span>
        <input aria-label="Book cover title" readOnly value={activeBook.title} />
      </label>
      <label className="book-cover-field">
        <span>Subtitle text</span>
        <input
          aria-label="Book cover subtitle"
          maxLength={120}
          onChange={(event) => updateBookField('coverSubtitle', event.target.value)}
          placeholder="Optional subtitle"
          value={activeBook.coverSubtitle}
        />
      </label>
      <label className="book-cover-field">
        <span>Blurb</span>
        <textarea
          aria-label="Book blurb"
          maxLength={2000}
          onChange={(event) => updateBookField('blurb', event.target.value)}
          placeholder="This will be where the blurb/summary of your novel will go."
          rows={4}
          value={activeBook.blurb}
        />
      </label>
      <label className="book-cover-field">
        <span>Author name</span>
        <input
          aria-label="Book author name"
          maxLength={100}
          onChange={(event) => updateBookField('authorName', event.target.value)}
          placeholder="Your name"
          value={activeBook.authorName}
        />
      </label>
      <label className="book-cover-field">
        <span>Upload a cover image</span>
        <input
          accept="image/jpeg,image/png,image/webp,image/avif"
          aria-label="Upload book cover"
          onChange={uploadCover}
          type="file"
        />
      </label>
      <div className="book-cover-preview-wrap">
        <div
          aria-label={`Cover preview for ${activeBook.title}`}
          className="book-cover-preview"
          role="img"
          style={coverUrl ? { backgroundImage: `url("${coverUrl}")` } : undefined}
        >
          <div className="book-cover-title">
            <strong>{activeBook.title || 'Your story title'}</strong>
            {activeBook.coverSubtitle && <span>{activeBook.coverSubtitle}</span>}
          </div>
          {activeBook.authorName && <span className="book-cover-author">by {activeBook.authorName}</span>}
        </div>
      </div>
      {activeBook.blurb && <p className="book-cover-blurb">{activeBook.blurb}</p>}
      <p className="book-cover-status" role={coverError ? 'alert' : 'status'}>
        {coverError || coverStatus || 'Cover images must be 5 MB or smaller.'}
      </p>
    </section>
  );
}

function WritingPanel({
  books,
  activeBook,
  goalProgress,
  chapters,
  activeChapter,
  activePage,
  spellCheck,
  onConvertDraft,
  onExportManuscript,
  isAddingBook,
  newBookTitle,
  onBookChange,
  onDeleteBook,
  onRenameBook,
  onAddBookClick,
  onNewBookTitleChange,
  onAddBookSubmit,
  onCancelAddBook,
  editorFont,
  editorFontSize,
  onEditorFontChange,
  onEditorFontSizeChange,
  onChapterChange,
  onDeleteChapter,
  onPageChange,
  onAddPage,
  onAutoSplitPage,
  onDeletePage,
  onUpdatePage,
  onSpellCheckChange,
  onCreateHighlight,
  onAddChapter,
  onUpdateChapter,
  userId,
  offlinePreview,
  onUpdateBook,
}) {
  const manuscriptRef = useRef(null);
  const selectedRangeRef = useRef(null);
  const focusNewPageRef = useRef(false);
  const autoSplitTimeoutRef = useRef(null);
  const [expandedChapterIds, setExpandedChapterIds] = useState(() => (
    activeChapter ? [activeChapter.id] : []
  ));
  const [hasSelection, setHasSelection] = useState(false);
  const editorCounts = {
    words: countWords(activePage?.content ?? ''),
    characters: (activePage?.content ?? '').replace(/\r?\n/g, '').length,
    nonWhitespaceCharacters: Array.from(activePage?.content ?? '')
      .filter((character) => !/\s/u.test(character)).length,
  };
  const previousPageIdRef = useRef(null);
  const [selectedAlignment, setSelectedAlignment] = useState('left');
  const [selectedLineSpacing, setSelectedLineSpacing] = useState('1.5');
  const [isExportMenuOpen, setIsExportMenuOpen] = useState(false);
  const [exportStatus, setExportStatus] = useState('');
  const fontFamilies = {
    serif: 'var(--serif)',
    'sans-serif': 'var(--sans)',
    monospace: 'ui-monospace, SFMono-Regular, Consolas, monospace',
    'times-new-roman': '"Times New Roman", Times, serif',
    arial: 'Arial, Helvetica, sans-serif',
  };

  useLayoutEffect(() => {
    if (previousPageIdRef.current === activePage?.id) return;
    previousPageIdRef.current = activePage?.id;
    const editor = manuscriptRef.current;
    if (!editor) return;
    const html = activePage?.contentHtml
      ? sanitizeEditorHtml(activePage.contentHtml)
      : plainTextToEditorHtml(activePage?.content ?? '');
    editor.innerHTML = html;
    selectedRangeRef.current = null;
    window.getSelection()?.removeAllRanges();
    if (focusNewPageRef.current) {
      focusNewPageRef.current = false;
      editor.focus();
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
  }, [activePage?.id, activePage?.content, activePage?.contentHtml]);

  useEffect(() => () => window.clearTimeout(autoSplitTimeoutRef.current), []);

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
    if (!editor || !activeChapter || !activePage) return;
    const html = sanitizeEditorHtml(editor.innerHTML);
    if (editor.innerHTML !== html) editor.innerHTML = html;
    onUpdatePage(activeChapter.id, activePage.id, 'content', editorHtmlToPlainText(html));
    onUpdatePage(activeChapter.id, activePage.id, 'contentHtml', html);
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

  const performAutoSplit = (shouldFocus = true) => {
    const editor = manuscriptRef.current;
    if (!editor || !activeChapter || !activePage) return false;
    const pageHtmlChunks = splitEditorIntoPages(editor, AUTO_PAGE_CHAR_LIMIT);
    if (!pageHtmlChunks) return false;

    window.clearTimeout(autoSplitTimeoutRef.current);
    autoSplitTimeoutRef.current = null;
    focusNewPageRef.current = shouldFocus;
    onAutoSplitPage(activeChapter.id, activePage.id, pageHtmlChunks);
    selectedRangeRef.current = null;
    setHasSelection(false);
    return true;
  };

  const handleEditorBlur = () => {
    if (autoSplitTimeoutRef.current !== null) performAutoSplit(false);
  };

  const handleContinuousWritingChange = (event) => {
    const enabled = event.target.checked;
    onUpdateBook(activeBook.id, { continuousWriting: enabled });

    if (enabled) {
      window.clearTimeout(autoSplitTimeoutRef.current);
      autoSplitTimeoutRef.current = null;
      return;
    }

    const editor = manuscriptRef.current;
    if (editor && editorHasReachedPageLimit(editor, AUTO_PAGE_CHAR_LIMIT)) {
      performAutoSplit();
    }
  };

  const handleEditorInput = ({ splitWhenNotAtEnd = false } = {}) => {
    const editor = manuscriptRef.current;
    if (!editor || !activeChapter || !activePage) return;
    const selection = window.getSelection();
    const caretRange = selection?.rangeCount ? selection.getRangeAt(0) : null;
    let caretAtEnd = false;
    if (
      caretRange?.collapsed
      && editor.contains(caretRange.startContainer)
      && editor.contains(caretRange.endContainer)
    ) {
      const trailingRange = caretRange.cloneRange();
      trailingRange.selectNodeContents(editor);
      trailingRange.setStart(caretRange.endContainer, caretRange.endOffset);
      caretAtEnd = trailingRange.toString().length === 0;
    }

    const html = sanitizeEditorHtml(editor.innerHTML);
    if (editor.innerHTML !== html) editor.innerHTML = html;
    if (
      activeBook.continuousWriting !== true
      && (caretAtEnd || splitWhenNotAtEnd)
      && editorHasReachedPageLimit(editor, AUTO_PAGE_CHAR_LIMIT)
    ) {
      if (splitWhenNotAtEnd) {
        if (performAutoSplit()) return;
      } else {
        window.clearTimeout(autoSplitTimeoutRef.current);
        autoSplitTimeoutRef.current = window.setTimeout(() => {
          autoSplitTimeoutRef.current = null;
          performAutoSplit();
        }, AUTO_PAGE_SPLIT_DELAY);
      }
    }

    const text = editorHtmlToPlainText(html);
    const hasText = Boolean(text.trim());
    editor.classList.toggle('manuscript-empty', !hasText);
    editor.dataset.empty = String(!hasText);
    onUpdatePage(activeChapter.id, activePage.id, 'content', text);
    onUpdatePage(activeChapter.id, activePage.id, 'contentHtml', html);
    selectedRangeRef.current = null;
    setHasSelection(false);
  };

  const handleEditorPaste = (event) => {
    event.preventDefault();
    const editor = event.currentTarget;
    const selection = window.getSelection();
    if (!editor || !activeChapter || !activePage) return;
    const pastedText = event.clipboardData?.getData('text/plain') ?? '';
    if (!pastedText) return;

    const currentRange = selection?.rangeCount ? selection.getRangeAt(0) : null;
    const hasEditorSelection = currentRange
      && editor.contains(currentRange.startContainer)
      && editor.contains(currentRange.endContainer);
    const range = hasEditorSelection ? currentRange : document.createRange();
    if (!hasEditorSelection) {
      range.selectNodeContents(editor);
      range.collapse(false);
    }
    range.deleteContents();
    const textNode = document.createTextNode(pastedText);
    range.insertNode(textNode);
    range.setStartAfter(textNode);
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);
    handleEditorInput({ splitWhenNotAtEnd: true });
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
        <BookCoverEditor
          activeBook={activeBook}
          key={activeBook.id}
          offlinePreview={offlinePreview}
          onUpdateBook={onUpdateBook}
          userId={userId}
        />
        <details className="book-management">
          <summary>Story options</summary>
          <button
            className="delete-book-button"
            disabled={books.length <= 1}
            onClick={() => onDeleteBook(activeBook.id)}
            type="button"
          >
            Delete this story
          </button>
          {books.length <= 1 && <span className="book-management-hint">Keep at least one story in your workspace.</span>}
          <form
            className="rename-book-form"
            onSubmit={(event) => {
              event.preventDefault();
              const title = new FormData(event.currentTarget).get('story-title');
              onRenameBook(activeBook.id, title);
            }}
          >
            <label htmlFor="story-title">Rename this story</label>
            <div>
              <input
                defaultValue={activeBook.title}
                id="story-title"
                key={activeBook.id}
                maxLength={100}
                name="story-title"
                required
              />
              <button className="text-button" type="submit">Save</button>
            </div>
          </form>
        </details>
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
            <div className="chapter-entry" key={chapter.id}>
              <div className="chapter-row">
                <button
                  aria-current={chapter.id === activeChapter?.id ? 'page' : undefined}
                  className={`chapter-item ${chapter.id === activeChapter?.id ? 'chapter-active' : ''}`}
                  onClick={() => onChapterChange(chapter.id)}
                  type="button"
                >
                  <span className="chapter-number">{String(index + 1).padStart(2, '0')}</span>
                  <span className="chapter-name">{chapter.title || `Chapter ${index + 1}`}</span>
                </button>
                <button
                  aria-label={`Add page to ${chapter.title || `Chapter ${index + 1}`}`}
                  className="chapter-add-page"
                  onClick={() => {
                    onAddPage(chapter.id);
                    setExpandedChapterIds((current) => current.includes(chapter.id)
                      ? current
                      : [...current, chapter.id]);
                  }}
                  title="Add a page"
                  type="button"
                >
                  +
                </button>
                <button
                  aria-label={`Delete ${chapter.title || `Chapter ${index + 1}`}`}
                  className="chapter-delete"
                  disabled={chapters.length <= 1}
                  onClick={() => {
                    onDeleteChapter(chapter.id);
                    setExpandedChapterIds((current) => current.filter((chapterId) => chapterId !== chapter.id));
                  }}
                  title={chapters.length <= 1 ? 'A story must have at least one chapter' : `Delete ${chapter.title || `Chapter ${index + 1}`}`}
                  type="button"
                >
                  ×
                </button>
                <button
                  aria-expanded={expandedChapterIds.includes(chapter.id)}
                  aria-label={`${expandedChapterIds.includes(chapter.id) ? 'Collapse' : 'Expand'} pages for ${chapter.title || `Chapter ${index + 1}`}`}
                  className="chapter-expand-pages"
                  onClick={() => setExpandedChapterIds((current) => (
                    current.includes(chapter.id)
                      ? current.filter((chapterId) => chapterId !== chapter.id)
                      : [...current, chapter.id]
                  ))}
                  title={`${expandedChapterIds.includes(chapter.id) ? 'Collapse' : 'Expand'} pages`}
                  type="button"
                >
                  {expandedChapterIds.includes(chapter.id) ? '⌄' : '›'}
                </button>
              </div>
              {expandedChapterIds.includes(chapter.id) && (
                <div className="chapter-pages" aria-label={`Pages in ${chapter.title || `Chapter ${index + 1}`}`}>
                  {chapter.pages.map((page, pageIndex) => (
                    <div className="chapter-page-row" key={page.id}>
                      <button
                        aria-current={page.id === activePage?.id ? 'page' : undefined}
                        className={`chapter-page-item ${page.id === activePage?.id ? 'chapter-page-active' : ''}`}
                        onClick={() => onPageChange(chapter.id, page.id)}
                        type="button"
                      >
                        Page {pageIndex + 1}
                      </button>
                      <button
                        aria-label={`Delete Page ${pageIndex + 1}`}
                        className="chapter-page-delete"
                        disabled={chapter.pages.length <= 1}
                        onClick={() => onDeletePage(chapter.id, page.id)}
                        title={chapter.pages.length <= 1 ? 'A chapter must have at least one page' : `Delete Page ${pageIndex + 1}`}
                        type="button"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
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
                  <option value="times-new-roman">Times New Roman</option>
                  <option value="arial">Arial</option>
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
              <label
                className="continuous-writing-option"
                title="When checked, keep writing on this page after 2,000 non-whitespace characters. When unchecked, automatically start a new page at the limit."
              >
                <input
                  checked={activeBook.continuousWriting === true}
                  onChange={handleContinuousWritingChange}
                  type="checkbox"
                />
                <span>Continuous (keep writing)</span>
              </label>
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
                      pageId: activePage.id,
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
              className={`manuscript-input ${activePage?.content ? '' : 'manuscript-empty'}`}
              contentEditable
              data-placeholder={
                activeChapter.id === activeBook.chapters[0]?.id && activePage?.id === activeChapter.pages[0]?.id
                  ? 'Start creating your world here…'
                  : ''
              }
              data-empty={activePage?.content ? 'false' : 'true'}
              onKeyDown={handleEditorKeyDown}
              onInput={handleEditorInput}
              onBlur={handleEditorBlur}
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
            {activeBook.continuousWriting === true
              && editorCounts.nonWhitespaceCharacters >= AUTO_PAGE_CHAR_LIMIT && (
                <p className="continuous-writing-hint" role="status">
                  Page length reached. Consider adding a page break, or keep writing here in Continuous mode.
                </p>
              )}
            <div className="writing-footer">
              <div className="writing-footer-progress">
                <span title="Character count includes spaces and punctuation; line breaks are excluded">
                  {`${editorCounts.words} words · ${editorCounts.characters} characters`}
                </span>
                {goalProgress && (
                  <div className="writing-goal-progress">
                    <div className="writing-goal-progress-heading">
                      <span>Daily writing goal</span>
                      <span>{goalProgress.percent}%</span>
                    </div>
                    <div
                      aria-label={`Daily writing goal ${goalProgress.percent}% complete`}
                      aria-valuemax={100}
                      aria-valuemin={0}
                      aria-valuenow={goalProgress.percent}
                      className="writing-goal-progress-track"
                      role="progressbar"
                    >
                      <span style={{ width: `${goalProgress.percent}%` }} />
                    </div>
                    <span className="writing-goal-progress-label">{goalProgress.label}</span>
                  </div>
                )}
              </div>
              <div className="writing-footer-actions">
                <div className="writing-footer-buttons">
                  <button
                    className="new-page-button"
                    onClick={() => onAddPage(activeChapter.id)}
                    type="button"
                  >
                    ＋ New page
                  </button>
                  <button
                    className="clear-button"
                    onClick={() => {
                      if (manuscriptRef.current) manuscriptRef.current.innerHTML = '<p><br></p>';
                      selectedRangeRef.current = null;
                      setHasSelection(false);
                      onUpdatePage(activeChapter.id, activePage.id, 'content', '');
                      onUpdatePage(activeChapter.id, activePage.id, 'contentHtml', '');
                    }}
                    type="button"
                  >
                    Clear page
                  </button>
                </div>
                <span className="active-page-number">
                  Page {Math.max(1, activeChapter.pages.findIndex((page) => page.id === activePage?.id) + 1)}
                </span>
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
    { value: 'pestel', label: 'Pestel', swatch: '#F8C8DC' },
    { value: 'stardust', label: 'Stardust', swatch: '#E1F6FF' },
    { value: 'lavender', label: 'Lavender', swatch: '#E6E5FA' },
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
          {option.swatch ? (
            <span aria-hidden="true" className="theme-option-swatch" style={{ backgroundColor: option.swatch }} />
          ) : (
            <span aria-hidden="true">{option.icon}</span>
          )}
          <span className="theme-option-label">{option.label}</span>
        </button>
      ))}
    </div>
  );
}

function Dashboard({ userId, userMetadata, onGoalProgress, goalProgress, offlinePreview = false }) {
  const [workspace, setWorkspace] = useState(initialWorkspace);
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
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
  const dailyGoalStateRef = useRef(null);

  useEffect(() => {
    let current = true;

    const loadWorkspace = async () => {
      setWorkspaceReady(false);
      setWorkspaceLoadError('');
      try {
        if (offlinePreview) {
          if (current) {
            setWorkspace(readWorkspace(LOCAL_PREVIEW_WORKSPACE_KEY));
            setWorkspaceReady(true);
            setSaveStatus('Saved on this device');
          }
          return;
        }

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
  }, [userId, loadAttempt, offlinePreview]);

  useEffect(() => {
    document.documentElement.dataset.theme = workspace.theme;
  }, [workspace.theme]);

  useEffect(() => {
    if (!workspaceReady) return undefined;

    const timeout = window.setTimeout(() => {
      const revision = ++saveRevisionRef.current;
      setSaveStatus(offlinePreview ? 'Saving to this device…' : 'Saving to cloud…');
      saveQueueRef.current = saveQueueRef.current
        .then(async () => {
          if (offlinePreview) {
            window.localStorage.setItem(LOCAL_PREVIEW_WORKSPACE_KEY, JSON.stringify(workspace));
            if (revision === saveRevisionRef.current) setSaveStatus('Saved on this device');
            return;
          }

          const { error } = await supabase.from('user_workspaces').upsert({
            user_id: userId,
            workspace,
            updated_at: new Date().toISOString(),
          }, { onConflict: 'user_id' });
          if (error) throw error;
          if (revision === saveRevisionRef.current) setSaveStatus('Saved to cloud');
        })
        .catch((error) => {
          console.error(
            offlinePreview ? 'Could not save the local preview workspace.' : 'Could not save the writing workspace to Supabase.',
            error,
          );
          if (revision === saveRevisionRef.current) {
            setSaveStatus(offlinePreview ? 'Could not save on this device' : 'Could not save to cloud');
          }
        });
    }, 350);

    return () => window.clearTimeout(timeout);
  }, [workspace, userId, workspaceReady, offlinePreview]);

  useEffect(() => {
    if (!workspaceReady) return;
    const wordCounts = getDailyWordCounts(workspace);
    const dailyState = readDailyGoalState(userId, wordCounts);
    dailyGoalStateRef.current = dailyState;
    onGoalProgress(makeGoalProgress(userMetadata, dailyState, wordCounts));
  }, [workspace, workspaceReady, userId, userMetadata, onGoalProgress]);

  useEffect(() => {
    if (!workspaceReady || userMetadata?.daily_goal_type !== 'minutes') return undefined;

    const timer = window.setInterval(() => {
      const editor = document.activeElement;
      if (
        document.visibilityState !== 'visible'
        || !(editor instanceof HTMLElement)
        || !editor.classList.contains('manuscript-input')
      ) return;

      const wordCounts = getDailyWordCounts(workspaceRef.current);
      let dailyState = dailyGoalStateRef.current ?? readDailyGoalState(userId, wordCounts);
      if (dailyState.date !== localDateKey()) {
        dailyState = readDailyGoalState(userId, wordCounts);
      }
      dailyState.seconds += 1;
      dailyGoalStateRef.current = dailyState;
      saveDailyGoalState(userId, dailyState);
      onGoalProgress(makeGoalProgress(userMetadata, dailyState, {}));
    }, 1000);

    return () => window.clearInterval(timer);
  }, [workspaceReady, userId, userMetadata, onGoalProgress]);

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

  const updateBook = (bookId, updates) => {
    updateWorkspace((current) => ({
      ...current,
      books: current.books.map((book) => book.id === bookId ? { ...book, ...updates } : book),
    }));
  };

  const activeBook = workspace.books.find((book) => book.id === workspace.activeBookId) ?? workspace.books[0];
  const switchBook = (bookId) => updateWorkspace({ activeBookId: bookId });
  const renameBook = (bookId, title) => {
    const normalizedTitle = title.trim();
    if (!normalizedTitle) return;
    updateWorkspace((current) => ({
      ...current,
      books: current.books.map((book) => book.id === bookId ? { ...book, title: normalizedTitle } : book),
    }));
  };
  const deleteBook = async (bookId) => {
    const bookToDelete = workspace.books.find((book) => book.id === bookId);
    if (!bookToDelete || workspace.books.length <= 1) return;

    const confirmed = window.confirm(`Delete "${bookToDelete.title}" and all of its chapters, notes, and planning data? This cannot be undone.`);
    if (!confirmed) return;

    if (bookToDelete.coverImagePath && !offlinePreview) {
      try {
        const { error } = await supabase.storage
          .from(BOOK_COVER_BUCKET)
          .remove([bookToDelete.coverImagePath]);
        if (error) throw error;
      } catch (error) {
        console.error('Could not remove the deleted story cover from Supabase Storage.', error);
        window.alert('The story will be deleted, but its cover image could not be removed from storage.');
      }
    }

    updateWorkspace((current) => {
      const deletedIndex = current.books.findIndex((book) => book.id === bookId);
      const books = current.books.filter((book) => book.id !== bookId);
      const activeBookId = current.activeBookId === bookId
        ? books[Math.min(deletedIndex, books.length - 1)].id
        : current.activeBookId;
      return { ...current, books, activeBookId };
    });
  };

  useEffect(() => {
    const pending = pendingReviewRef.current;
    if (
      !pending
      || activeTab !== 'write'
      || activeBook.id !== pending.bookId
      || activeBook.activeChapterId !== pending.chapterId
      || activeBook.activePageId !== pending.pageId
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
  }, [activeBook.id, activeBook.activeChapterId, activeBook.activePageId, activeTab]);

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
      const chapterId = `${current.id}-chapter-${Date.now()}`;
      const page = { id: `${chapterId}-page-1`, content: '', contentHtml: '' };
      const chapter = {
        id: chapterId,
        title: `Chapter ${current.chapters.length + 1}`,
        content: '',
        contentHtml: '',
        pages: [page],
      };
      return {
        ...current,
        chapters: [...current.chapters, chapter],
        activeChapterId: chapter.id,
        activePageId: page.id,
      };
    });
  };

  const deleteChapter = (chapterId) => {
    const chapterIndex = activeBook.chapters.findIndex((chapter) => chapter.id === chapterId);
    if (chapterIndex < 0 || activeBook.chapters.length <= 1) return;
    const chapter = activeBook.chapters[chapterIndex];
    const title = chapter.title?.trim() || `Chapter ${chapterIndex + 1}`;
    if (!window.confirm(`Delete "${title}" and all ${chapter.pages.length} of its pages? This cannot be undone. Notes and highlights will stay in Notes.`)) return;

    const chapters = activeBook.chapters.filter((item) => item.id !== chapterId);
    const nextChapter = activeBook.activeChapterId === chapterId
      ? chapters[Math.min(chapterIndex, chapters.length - 1)]
      : null;
    updateActiveBook((current) => ({
      ...current,
      chapters: current.chapters.filter((item) => item.id !== chapterId),
      ...(nextChapter
        ? { activeChapterId: nextChapter.id, activePageId: nextChapter.pages[0]?.id }
        : {}),
    }));
  };

  const addPage = (chapterId) => {
    updateActiveBook((current) => {
      const chapter = current.chapters.find((item) => item.id === chapterId);
      if (!chapter) return current;
      const page = {
        id: `${chapter.id}-page-${Date.now()}`,
        content: '',
        contentHtml: '',
      };
      return {
        ...current,
        chapters: current.chapters.map((item) => item.id === chapterId
          ? { ...item, pages: [...item.pages, page] }
          : item),
        activeChapterId: chapter.id,
        activePageId: page.id,
      };
    });
  };

  const autoSplitPage = (chapterId, pageId, pageHtmlChunks) => {
    if (pageHtmlChunks.length < 2) return;
    const nextPageIds = pageHtmlChunks.slice(1).map((_, index) => (
      `${chapterId}-page-${Date.now()}-${index}`
    ));

    updateActiveBook((current) => ({
      ...current,
      chapters: current.chapters.map((chapter) => {
        if (chapter.id !== chapterId) return chapter;
        const pageIndex = chapter.pages.findIndex((page) => page.id === pageId);
        if (pageIndex < 0) return chapter;
        const updatedPages = pageHtmlChunks.map((contentHtml, index) => ({
          ...(index === 0 ? chapter.pages[pageIndex] : {}),
          id: index === 0 ? pageId : nextPageIds[index - 1],
          contentHtml,
          content: editorHtmlToPlainText(contentHtml),
        }));
        const pages = [
          ...chapter.pages.slice(0, pageIndex),
          ...updatedPages,
          ...chapter.pages.slice(pageIndex + 1),
        ];
        const firstPage = pages[0];
        return {
          ...chapter,
          pages,
          content: firstPage.content,
          contentHtml: firstPage.contentHtml,
        };
      }),
      activeChapterId: chapterId,
      activePageId: nextPageIds.at(-1),
    }));
  };

  const deletePage = (chapterId, pageId) => {
    const chapter = activeBook.chapters.find((item) => item.id === chapterId);
    if (!chapter || chapter.pages.length <= 1) return;
    const pageIndex = chapter.pages.findIndex((page) => page.id === pageId);
    if (pageIndex < 0) return;
    if (!window.confirm(`Delete Page ${pageIndex + 1}? This cannot be undone.`)) return;

    updateActiveBook((current) => ({
      ...current,
      chapters: current.chapters.map((item) => {
        if (item.id !== chapterId || item.pages.length <= 1) return item;
        const currentPageIndex = item.pages.findIndex((page) => page.id === pageId);
        if (currentPageIndex < 0) return item;
        const pages = item.pages.filter((page) => page.id !== pageId);
        const firstPage = pages[0];
        return {
          ...item,
          pages,
          content: firstPage.content,
          contentHtml: firstPage.contentHtml,
        };
      }),
      ...(current.activeChapterId === chapterId && current.activePageId === pageId
        ? {
          activePageId: chapter.pages
            .filter((page) => page.id !== pageId)[Math.min(pageIndex, chapter.pages.length - 2)]?.id,
        }
        : {}),
    }));
  };

  const updateChapter = (id, field, value) => {
    updateActiveBook((current) => ({
      ...current,
      chapters: current.chapters.map((chapter) => chapter.id === id ? { ...chapter, [field]: value } : chapter),
    }));
  };

  const updatePage = (chapterId, pageId, field, value) => {
    updateActiveBook((current) => ({
      ...current,
      chapters: current.chapters.map((chapter) => {
        if (chapter.id !== chapterId) return chapter;
        const pages = chapter.pages.map((page) => page.id === pageId ? { ...page, [field]: value } : page);
        const firstPage = pages[0];
        return {
          ...chapter,
          pages,
          ...(firstPage?.id === pageId ? { [field]: value } : {}),
        };
      }),
    }));
  };

  const createHighlight = ({ excerpt, start, end, chapterId, pageId, chapterTitle }) => {
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
      pageId,
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
      pageId: note.pageId ?? chapter.pages[0]?.id,
      start: note.start,
      end: note.end,
      excerpt: note.excerpt,
    };
    updateActiveBook({ activeChapterId: chapter.id, activePageId: note.pageId ?? chapter.pages[0]?.id });
    setActiveTab('write');
  };

  const activeChapter = activeBook.chapters.find((chapter) => chapter.id === activeBook.activeChapterId);
  const activePage = activeChapter?.pages.find((page) => page.id === activeBook.activePageId)
    ?? activeChapter?.pages[0];
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
      {offlinePreview && (
        <p className="local-preview-notice" role="status">
          Offline preview: your work is saved only in this browser and does not sync to your live account.
        </p>
      )}
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
            key={activeBook.id}
            activeBook={activeBook}
            goalProgress={goalProgress}
            activeChapter={activeChapter}
            activePage={activePage}
            books={workspace.books}
            chapters={activeBook.chapters}
            editorFont={activeBook.editorFont ?? initialBook.editorFont}
            editorFontSize={activeBook.editorFontSize ?? initialBook.editorFontSize}
            spellCheck={activeBook.spellCheck !== false}
            onAddChapter={addChapter}
            onAddBookClick={() => setIsAddingBook(true)}
            onDeleteBook={deleteBook}
            onRenameBook={renameBook}
            onAddBookSubmit={addBook}
            onBookChange={switchBook}
            onCancelAddBook={() => { setIsAddingBook(false); setNewBookTitle(''); }}
            onChapterChange={(id) => {
              const chapter = activeBook.chapters.find((item) => item.id === id);
              updateActiveBook({ activeChapterId: id, activePageId: chapter?.pages[0]?.id });
            }}
            onDeleteChapter={deleteChapter}
            onPageChange={(chapterId, pageId) => updateActiveBook({
              activeChapterId: chapterId,
              activePageId: pageId,
            })}
            onAddPage={addPage}
            onAutoSplitPage={autoSplitPage}
            onDeletePage={deletePage}
            onEditorFontChange={(editorFont) => updateActiveBook({ editorFont })}
            onEditorFontSizeChange={(editorFontSize) => updateActiveBook({ editorFontSize })}
            onSpellCheckChange={(spellCheck) => updateActiveBook({ spellCheck })}
            onConvertDraft={convertDraft}
            onExportManuscript={(format) => exportManuscript(activeBook, format)}
            onCreateHighlight={createHighlight}
            onNewBookTitleChange={setNewBookTitle}
            onUpdateChapter={updateChapter}
            onUpdatePage={updatePage}
            onUpdateBook={updateBook}
            userId={userId}
            offlinePreview={offlinePreview}
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

function AuthPage({ register = false, offlinePreview = false }) {
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
        ? await supabase.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo: `${window.location.origin}${window.location.pathname}`,
          },
        })
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
      {offlinePreview && (
        <p className="auth-workspace-link">
          <Link to="/dashboard">Open the offline local preview</Link>
        </p>
      )}
    </main>
  );
}

function ProfileSettings({ user, offlinePreview = false, onOfflineProfileSave }) {
  const [displayName, setDisplayName] = useState(user.user_metadata?.display_name ?? '');
  const [bio, setBio] = useState(user.user_metadata?.bio ?? '');
  const savedGoalType = user.user_metadata?.daily_goal_type;
  const [dailyGoalType, setDailyGoalType] = useState(
    ['none', 'words', 'minutes'].includes(savedGoalType) ? savedGoalType : 'none',
  );
  const [dailyGoalTarget, setDailyGoalTarget] = useState(
    user.user_metadata?.daily_goal_target?.toString() ?? '500',
  );
  const [status, setStatus] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  const saveProfile = async (event) => {
    event.preventDefault();
    setStatus('');
    setErrorMessage('');
    setIsSaving(true);
    try {
      const profile = {
        display_name: displayName.trim() || null,
        bio: bio.trim() || null,
        daily_goal_type: dailyGoalType,
        daily_goal_target: dailyGoalType === 'none' ? null : Number(dailyGoalTarget),
      };
      if (offlinePreview) {
        window.localStorage.setItem(LOCAL_PREVIEW_PROFILE_KEY, JSON.stringify(profile));
        onOfflineProfileSave(profile);
      } else {
        const { error } = await supabase.auth.updateUser({ data: profile });
        if (error) throw error;
      }
      setStatus('Profile saved.');
    } catch (error) {
      console.error('Could not save profile settings.', error);
      setErrorMessage(error.message || 'Could not save your profile. Please try again.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <main className="auth-page profile-page">
      {offlinePreview && (
        <p className="local-preview-notice" role="status">
          Offline preview: profile settings are saved only in this browser.
        </p>
      )}
      <span className="eyebrow">{offlinePreview ? 'Local preview' : 'Your account'}</span>
      <h1>Profile settings</h1>
      <p>
        {offlinePreview
          ? 'These settings are for this local preview and are not connected to an account.'
          : 'Your display name personalizes your workspace link. Your bio is saved with your account and is not shown as a public profile.'}
      </p>
      <form aria-label="Profile settings" className="auth-form profile-form" onSubmit={saveProfile}>
        <label htmlFor="profile-email">{offlinePreview ? 'Account status' : 'Account email'}</label>
        <input autoComplete={offlinePreview ? undefined : 'email'} id="profile-email" readOnly value={offlinePreview ? 'Offline — no account connected' : user.email ?? ''} />
        <label htmlFor="profile-display-name">Display name</label>
        <input
          autoComplete="name"
          id="profile-display-name"
          maxLength={40}
          onChange={(event) => setDisplayName(event.target.value)}
          placeholder={user.email?.split('@')[0] ?? 'Your name'}
          value={displayName}
        />
        <label htmlFor="profile-bio">Short bio</label>
        <textarea
          id="profile-bio"
          maxLength={240}
          onChange={(event) => setBio(event.target.value)}
          placeholder="A little about you or what you like to write…"
          rows={4}
          value={bio}
        />
        <span className="profile-character-count">{bio.length}/240</span>
        <label htmlFor="profile-daily-goal">Daily writing goal</label>
        <select
          id="profile-daily-goal"
          onChange={(event) => setDailyGoalType(event.target.value)}
          value={dailyGoalType}
        >
          <option value="none">No daily goal</option>
          <option value="words">Words written</option>
          <option value="minutes">Time writing</option>
        </select>
        {dailyGoalType !== 'none' && (
          <>
            <label htmlFor="profile-daily-goal-target">
              {dailyGoalType === 'words' ? 'Words per day' : 'Minutes per day'}
            </label>
            <input
              id="profile-daily-goal-target"
              max={dailyGoalType === 'words' ? 100000 : 1440}
              min="1"
              onChange={(event) => setDailyGoalTarget(event.target.value)}
              required
              type="number"
              value={dailyGoalTarget}
            />
          </>
        )}
        <p className="profile-goal-help">
          Word goals count net words added today across your stories. Time goals count while the writing editor is focused and this tab is visible. Daily progress is saved in this browser.
        </p>
        <button className="cta-btn" disabled={isSaving} type="submit">{isSaving ? 'Saving…' : 'Save profile'}</button>
      </form>
      {offlinePreview && <Link className="auth-workspace-link" to="/dashboard">Back to workspace</Link>}
      {status && <p className="profile-status" role="status">{status}</p>}
      {errorMessage && <p className="profile-status" role="alert">{errorMessage}</p>}
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
          <p><strong>Prototype service terms · Updated 18 October 2026.</strong> These terms apply when you use Your Writing Platform, including its sign-up, writing, and cloud-save features. The service is an evolving prototype and may be changed, interrupted, or withdrawn.</p>
          <p><strong>Your account and use.</strong> Provide an email address you control, keep your sign-in details private, and tell the project operator if you believe someone has accessed your account without permission. You are responsible for activity through your account and for using the service lawfully. Do not attempt to disrupt, probe, or gain unauthorized access to the app, Supabase project, or another user’s workspace.</p>
          <p><strong>Your content.</strong> You retain your rights to the writing and other material you submit. You are responsible for that material, including having the rights and permissions needed to store it here. You grant the operator and service providers a limited permission to host, transmit, back up, and process it only as needed to operate and support the service. Do not use the prototype as your only copy: export and keep your own backups.</p>
          <p><strong>Prototype and availability.</strong> The service is provided on an experimental, as-available basis. It may contain errors, lose data, be unavailable, or change without notice. To the extent permitted by law, the operator does not make guarantees that the service will be uninterrupted, error-free, secure, or suitable for a particular purpose. Nothing in these terms removes rights or remedies that cannot legally be excluded.</p>
          <p><strong>Responsibility and limits.</strong> You are responsible for your account use, content, and keeping independent copies of important work. To the extent permitted by law, the operator is not liable for indirect or consequential loss, or loss of content or access arising from use of this prototype. This does not limit liability where applicable law does not allow it to be limited.</p>
          <p><strong>Changes or ending access.</strong> The operator may suspend or discontinue the prototype, or restrict access where reasonably needed to protect the service, its users, or comply with law. If the service closes, cloud access and stored work may no longer be available; keep your own exports. These terms may be updated as the prototype changes. The version displayed here applies to use from its posted date, subject to any rights required by law.</p>
          <p><strong>Contact.</strong> For questions about these terms or account/data requests, use the contact information on the project owner’s GitHub profile. Do not include passwords or private writing in a public issue.</p>
        </>
      ),
    },
    privacy: {
      title: 'Privacy policy',
      content: (
        <>
          <p><strong>Prototype privacy notice · Updated 18 October 2026.</strong> This notice describes information handled when you visit or use Your Writing Platform. The prototype is hosted on GitHub Pages and uses Supabase for account authentication and cloud workspace storage. Applicable privacy requirements depend on where you and the project operator are located; this notice does not replace any rights or disclosures required by law.</p>
          <p><strong>Information handled.</strong> When you register or sign in, Supabase Authentication processes your email address, password credentials, account identifier, and authentication/session data. The app does not store your password in its workspace table. If you add them in Profile settings, your display name and optional short bio are saved as account metadata in Supabase; they personalize your signed-in navigation and are not presented as a public profile. When signed in, your books, chapters, drafts, settings, characters, world details, notes, scenes, and cover text are saved as workspace data in the Supabase project and associated with your account identifier. If you upload a book-cover image, it is stored in a private Supabase Storage bucket under your account. The app uses expiring signed URLs to display it; anyone with an active signed URL could access that image until the URL expires. In offline local preview, cover images are temporary and are not saved. If a browser has an older locally saved workspace, the app may read it and upload it to your account the first time it finds no cloud workspace.</p>
          <p><strong>Browser storage and cookies.</strong> The app uses browser local storage for the Supabase sign-in session, daily writing-goal progress, and may read an existing local workspace from an earlier version of the prototype. These are functional storage uses needed for sign-in, goal tracking, and workspace continuity. Daily goal progress is stored on this browser and does not sync between devices. The app does not intentionally use advertising, analytics, or cross-site tracking cookies. Your browser, GitHub Pages, Supabase, or other providers may use their own technical storage or logs to deliver, secure, and operate their services.</p>
          <p><strong>Technical and third-party requests.</strong> GitHub Pages and Supabase receive the network requests needed to deliver the app, authenticate users, and save work; their infrastructure may process technical data such as IP address, browser/device information, and request timestamps for operation and security. The app loads Newsreader and DM Sans from Google Fonts, so Google receives a request for those font resources and related connection information. Each provider handles information under its own terms and privacy practices.</p>
          <p><strong>Purpose, access, and sharing.</strong> Information is used to provide sign-in, save and retrieve workspaces, maintain and secure the prototype, and respond to support or legal requests. The project operator and people with authorized Supabase project access may be able to access account and workspace data. Supabase and hosting providers process information to provide their services. The operator does not sell personal information or use it for advertising, and the prototype does not send promotional emails.</p>
          <p><strong>Retention and your choices.</strong> Workspace data remains in the Supabase project until it is deleted by the project operator or the associated account is removed; the prototype does not currently offer an in-app account or data deletion control. To ask about access, correction, or deletion, use the contact information on the project owner’s GitHub profile. Do not include passwords or private writing in a public issue. You can also stop using the service and clear this app’s browser storage, but clearing browser storage alone does not delete cloud data.</p>
          <p><strong>Security and updates.</strong> The database is configured with access rules intended to limit normal app access to each user’s own workspace. No online service can guarantee absolute security, and the project operator or providers may have administrative access. This prototype may change; this notice will be updated if its data practices materially change. For privacy questions, use the project owner’s GitHub profile contact information.</p>
        </>
      ),
    },
    attributions: {
      title: 'Attributions',
      content: (
        <>
          <p>Typography: <a href="https://fonts.google.com/specimen/Newsreader" rel="noreferrer" target="_blank">Newsreader</a> and <a href="https://fonts.google.com/specimen/DM+Sans" rel="noreferrer" target="_blank">DM Sans</a>, served by Google Fonts.</p>
          <p>These typefaces are distributed under the SIL Open Font License. Visit each font’s page for its license and specimen details.</p>
          <p>Landing-page banner: “background.jpg” by Angela Marie, licensed under CC BY-NC. Cropped and converted to WebP for display. CC BY-NC permits noncommercial use only; confirm this license suits your use of the site.</p>
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
  const [goalProgress, setGoalProgress] = useState(null);
  const offlinePreview = import.meta.env.DEV && !supabase;
  const [offlineProfile, setOfflineProfile] = useState(readLocalPreviewProfile);
  const previewUser = { user_metadata: offlineProfile };

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
      <header><Navbar offlinePreview={offlinePreview} session={session} /></header>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/dashboard" element={
          !authReady
            ? <main className="auth-page"><h1>Loading…</h1></main>
            : offlinePreview
              ? (
                <Dashboard
                  key="local-preview"
                  offlinePreview
                  goalProgress={goalProgress}
                  onGoalProgress={setGoalProgress}
                  userId="local-preview"
                  userMetadata={offlineProfile}
                />
              )
              : session
              ? (
                <Dashboard
                  key={session.user.id}
                  goalProgress={goalProgress}
                  onGoalProgress={setGoalProgress}
                  userId={session.user.id}
                  userMetadata={session.user.user_metadata}
                />
              )
              : <Navigate to="/login" replace />
        } />
        <Route path="/profile" element={
          !authReady
            ? <main className="auth-page"><h1>Loading…</h1></main>
            : offlinePreview
              ? (
                <ProfileSettings
                  key="local-preview-profile"
                  offlinePreview
                  onOfflineProfileSave={setOfflineProfile}
                  user={previewUser}
                />
              )
              : session
              ? <ProfileSettings key={session.user.id} user={session.user} />
              : <Navigate to="/login" replace />
        } />
        <Route path="/login" element={
          !authReady
            ? <main className="auth-page"><h1>Loading…</h1></main>
            : offlinePreview
              ? <Navigate to="/dashboard" replace />
              : session
              ? <Navigate to="/dashboard" replace />
              : <AuthPage offlinePreview={offlinePreview} />
        } />
        <Route path="/register" element={
          !authReady
            ? <main className="auth-page"><h1>Loading…</h1></main>
            : offlinePreview
              ? <Navigate to="/dashboard" replace />
              : session
              ? <Navigate to="/dashboard" replace />
              : <AuthPage offlinePreview={offlinePreview} register />
        } />
        <Route path="*" element={
          !authReady
            ? <main className="auth-page"><h1>Loading…</h1></main>
            : <Navigate to={session ? '/dashboard' : '/'} replace />
        } />
      </Routes>
      <Footer />
    </Router>
  );
}

export default App;
