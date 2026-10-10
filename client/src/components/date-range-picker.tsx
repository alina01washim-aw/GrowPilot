import * as React from "react"
import { format } from "date-fns"
import { Calendar as CalendarIcon } from "lucide-react"
import { DateRange } from "react-day-picker"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { useIsMobile } from "@/hooks/use-mobile"

interface DatePickerWithRangeProps extends React.HTMLAttributes<HTMLDivElement> {
  date: DateRange | undefined
  setDate: (date: DateRange | undefined) => void
}

export function DatePickerWithRange({
  className,
  date,
  setDate,
}: DatePickerWithRangeProps) {
  const isMobile = useIsMobile()

  return (
    <div className={cn("grid gap-2 w-full sm:w-auto", className)}>
      <Popover>
        <PopoverTrigger asChild>
          <Button
            id="date"
            variant={"outline"}
            className={cn(
              "w-full sm:w-[280px] md:w-[300px] justify-start text-left font-normal bg-card h-9 sm:h-10 text-xs sm:text-sm",
              !date && "text-muted-foreground"
            )}
          >
            <CalendarIcon className="mr-2 h-4 w-4 shrink-0" />
            <span className="truncate">
              {date?.from ? (
                date.to ? (
                  <>
                    {format(date.from, isMobile ? "MMM d" : "LLL dd, y")} -{" "}
                    {format(date.to, isMobile ? "MMM d, y" : "LLL dd, y")}
                  </>
                ) : (
                  format(date.from, isMobile ? "MMM d, y" : "LLL dd, y")
                )
              ) : (
                "Pick a date range"
              )}
            </span>
          </Button>
        </PopoverTrigger>
        <PopoverContent
          className="w-auto max-w-[calc(100vw-2rem)] p-0"
          align={isMobile ? "start" : "end"}
        >
          <Calendar
            initialFocus
            mode="range"
            defaultMonth={date?.from}
            selected={date}
            onSelect={setDate}
            numberOfMonths={isMobile ? 1 : 2}
          />
        </PopoverContent>
      </Popover>
    </div>
  )
}
