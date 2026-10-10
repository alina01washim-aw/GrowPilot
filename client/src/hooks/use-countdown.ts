import { useEffect, useState } from "react";

export function useCountdown(targetDate: string | null | undefined): number {
  const [timeLeft, setTimeLeft] = useState(0);

  useEffect(() => {
    if (!targetDate) {
      setTimeLeft(0);
      return;
    }

    const calculateTimeLeft = () => {
      const target = new Date(targetDate).getTime();
      const now = new Date().getTime();
      const difference = target - now;
      return Math.max(0, Math.floor(difference / 1000));
    };

    setTimeLeft(calculateTimeLeft());

    const interval = setInterval(() => {
      const remaining = calculateTimeLeft();
      setTimeLeft(remaining);

      if (remaining <= 0) {
        clearInterval(interval);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [targetDate]);

  return timeLeft;
}
