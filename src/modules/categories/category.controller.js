export default class CategoryController {
  constructor(categoryService) {
    this.categoryService = categoryService;
  }

  createCategory = async (req, res) => {
    const { name } = req.body;

    if (!name) {
      return res.status(400).json({ error: "Nome da categoria é obrigatório" });
    }

    try {
      const { category, message } =
        await this.categoryService.createCategory(name);
      return res.json({ category, message });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  };

  listCategories = async (req, res) => {
    try {
      const categories = await this.categoryService.listCategories();
      return res.json(categories);
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  };
}
