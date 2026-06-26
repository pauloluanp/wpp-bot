export default class CategoryService {
  constructor(categoryRepository) {
    this.categoryRepository = categoryRepository;
  }

  async createCategory(name) {
    const category = await this.categoryRepository.createCategory(name);
    return { category, message: "Categoria criada com sucesso" };
  }
}
