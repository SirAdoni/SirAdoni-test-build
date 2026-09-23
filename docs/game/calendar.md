# Game Mode: In-world Calendar

A game can have its own calendar: named months of any length, your own weekday names, a year with an era, optional leap years and moons, plus a list of dated events and deadlines. You find it in the Session panel's **Tools** tab under **Calendar**, or from the command palette with **In-world calendar**.

## One date, not two

Game Mode already keeps a clock: the day number and time you see on the map panel's **Day** control. The Day editor, the automatic clock and time skips all move that one clock. The calendar does not keep a date of its own. It remembers only which calendar date the game's **Day 1** was, and shows every other day from there. Clock Day 12 is simply eleven days after Day 1 in your calendar.

That means:

- Setting the day by hand in the Day editor moves the calendar too.
- When the clock passes midnight, the calendar turns to the next date.
- Advancing the calendar moves the clock's day number. The time of day stays as it was.
- The clock never goes below Day 1, so moving back stops there.

## Setting up a calendar

1. Open **Tools**, find **Calendar**, and click **Set up calendar**.
2. List the months, one per line, as `name | days`. For example `Seedfall | 30`.
3. List the weekday names, separated by commas.
4. Optionally add an era written after the year, such as `AR`.
5. Under **Today (clock Day N) is**, pick today's date and its weekday. This renames the current day; it does not skip time.
6. Optionally fill in the leap rule and the moons, then click **Save**.

The editor starts from a familiar twelve-month calendar you can rename. You can reopen it at any time with **Edit calendar**.

### Leap years

The leap rule has three numbers. **Every N years** adds the leap days in years divisible by that number. **Except every** skips years divisible by the second number, and **Unless every** puts them back for years divisible by the third. `4`, `100`, `400` is the familiar rule. Leave **Every N years** empty for no leap years. Leap days go at the end of the month you pick.

### Moons

List each moon on its own line as `name | cycle days | days since new moon today`, for example `Pale Lamp | 29.5 | 3`. The calendar card shows each moon's phase for today.

## Moving the date

- The **-1d**, **+1d** and **+7d** buttons move the date by that many days.
- Type any number of days, negative to go back, and click **Advance**.
- Click a day in the month view, then **Make this today**. A date before the game's Day 1 becomes the new Day 1.

## Events and deadlines

Pick a day in the month view, type a title under **New event on ...**, choose **Event** or **Deadline**, and click **Add**. Tick **Yearly** for festivals that come back every year on the same day. A yearly event on a leap day falls on the month's last day in other years.

**Upcoming** lists what is coming, soonest first. A deadline whose date has passed shows as overdue until you tick it done. Days with events get a dot in the month view.

## What the GM sees

When a calendar is switched on, the GM's time line uses the calendar date instead of the free-text date from the tracker, followed by any event or deadline in the next two weeks. For example: `Oneday, 3 Emberwane 88 AR (upcoming: Lantern Fair tomorrow; deadline Toll owed in 4 days), Day 5, 14:00 (afternoon)`. A game without a calendar, or with it switched off, sends exactly the same time line as before.

## The calendar HUD widget

The GM can also make a **calendar** HUD widget, which counts in the same day numbers as the clock ("Day 21"). When your game has a calendar, that widget also lists your upcoming calendar events next to its own entries, without duplicates. Your events are not copied into the widget, so editing one never fights with the GM's widget updates.

## Where it is stored

The calendar is saved with the game's session chat, next to the clock, and a new session carries it forward just like the day and time. No separate storage is used.
