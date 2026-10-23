import express from 'express';
import { getSubjects, getChaptersBySubject, getTopicsByChapter, getTopicBySlug, submitMCQs } from '../controllers/study.controller.js';
import { protect } from '../middlewares/auth.middleware.js';

const router = express.Router();

router.get('/subjects', protect, getSubjects);
router.get('/subjects/:subjectSlug',protect, getChaptersBySubject);
router.get('/subjects/:subjectSlug/chapters',protect, getChaptersBySubject);
router.get('/chapters/:chapterId/topics',protect, getTopicsByChapter);
router.get('/topics/:topicSlug',protect, getTopicBySlug);
router.post('/topics/:topicSlug/submit',protect, submitMCQs);

export default router;
