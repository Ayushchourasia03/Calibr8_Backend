import express from 'express';
import {
  getSubjects,
  getChaptersBySubject,
  getTopicsByChapter,
  getTopicBySlug,
  submitMCQs,
} from '../controllers/study.controller.js';
import { protect } from '../middlewares/auth.middleware.js';

const router = express.Router();

// Lesson and curriculum reading stays public
router.get('/subjects', getSubjects);
router.get('/subjects/:subjectSlug', getChaptersBySubject);
router.get('/subjects/:subjectSlug/chapters', getChaptersBySubject);
router.get('/chapters/:chapterId/topics', getTopicsByChapter);
router.get('/topics/:topicSlug', getTopicBySlug);

// Submitting MCQ answers requires user authentication to save progress
router.post('/topics/:topicSlug/submit', protect, submitMCQs);

export default router;
