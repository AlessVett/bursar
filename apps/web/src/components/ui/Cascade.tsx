import { motion } from "motion/react";
import type { ReactNode } from "react";

export interface CascadeProps {
  /** Position in the list; the delay is 35 ms per step, capped at 10 steps. */
  index: number;
  children: ReactNode;
  className?: string;
}

/**
 * Entry animation for cards and list items: 180 ms fade and rise, no exit. Reduced motion is
 * honoured by the `MotionConfig reducedMotion="user"` the app shell provides.
 */
export function Cascade({ index, children, className }: CascadeProps) {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, delay: 0.035 * Math.min(Math.max(0, index), 10) }}
    >
      {children}
    </motion.div>
  );
}
