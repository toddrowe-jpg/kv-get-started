// blogWorkflowExamples.ts

/**
 * Blog Workflow Usage Examples
 */

// Basic Daily Workflow
const dailyWorkflow = () => {
    console.log("Start your day with a morning routine.");
    console.log("Review your tasks and prioritize.");
    console.log("Allocate time slots for each task.");
    console.log("Take regular breaks for better focus.");
    console.log("End your day with a quick review.");
};

dailyWorkflow();

// Budget Planning Scenario
const budgetPlanning = () => {
    const income = 5000;
    const expenses = {
        rent: 1200,
        food: 400,
        entertainment: 300,
        savings: 1000,
    };

    const totalExpenses = Object.values(expenses).reduce((a, b) => a + b, 0);
    const remainingBudget = income - totalExpenses;

    console.log(`Total Income: $${income}`);
    console.log(`Total Expenses: $${totalExpenses}`);
    console.log(`Remaining Budget: $${remainingBudget}`);
};

budgetPlanning();

// Weekly Schedule Scenario
const weeklySchedule = () => {
    const schedule = {
        Monday: ["Team Meeting", "Project Work"],
        Tuesday: ["Client Call", "Development"],
        Wednesday: ["Review Session", "Learning"]
    };

    for (const day in schedule) {
        console.log(`${day}: ${schedule[day].join(', ')}`);
    }
};

weeklySchedule();
