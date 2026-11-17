import { isChatMessageSkeleton, isQuizAttemptSkeleton } from '@openmaic/dsl';
import type { RuntimePayloadValidator } from '@openmaic/storage';

import { normalizeLearningPayload } from '@/lib/learning/store-payload';
import { whiteboardRuntimePayloadValidator } from '@/lib/whiteboard/runtime/validate';

const chat: RuntimePayloadValidator = (payload) =>
  isChatMessageSkeleton(payload)
    ? { valid: true }
    : {
        valid: false,
        errors: [
          {
            path: '/payload',
            message: 'chat payload must match ChatMessageSkeleton (role + content)',
          },
        ],
      };

const quizAttempt: RuntimePayloadValidator = (payload) =>
  isQuizAttemptSkeleton(payload)
    ? { valid: true }
    : {
        valid: false,
        errors: [
          {
            path: '/payload',
            message: 'quizAttempt payload must match QuizAttemptSkeleton (phase + answers)',
          },
        ],
      };

const learning: RuntimePayloadValidator = (payload) =>
  normalizeLearningPayload(payload)
    ? { valid: true }
    : {
        valid: false,
        errors: [
          {
            path: '/payload',
            message: 'learning payload must be version 1 evidence or reviewCards',
          },
        ],
      };

/** Complete app validator table. RuntimeStore options replace their defaults. */
export const APP_RUNTIME_PAYLOAD_VALIDATORS = Object.freeze({
  chat,
  quizAttempt,
  learning,
  whiteboard: whiteboardRuntimePayloadValidator,
}) satisfies Readonly<Record<string, RuntimePayloadValidator>>;
